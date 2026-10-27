import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {openDatabase} from '../server/sqlite.js';

const migrationsDirectory=new URL('../drizzle/',import.meta.url);
const migrationNames=()=>readdirSync(migrationsDirectory).filter(name=>name.endsWith('.sql')).sort();
const migrationSql=name=>readFileSync(new URL(name,migrationsDirectory),'utf8');
const digest=sql=>createHash('sha256').update(sql).digest('hex');
const id=()=>crypto.randomUUID();
const plain=value=>JSON.parse(JSON.stringify(value));

function temporaryDatabase(t){
  const scratch=new URL('../work/',import.meta.url);
  mkdirSync(scratch,{recursive:true});
  const directory=mkdtempSync(join(scratch.pathname,'workout-migration-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return join(directory,'test.sqlite');
}

function existingDatabase(path){
  const sqlite=new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE movement_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');
  for(const name of migrationNames().filter(name=>/^000[0-4]_/.test(name))){
    const sql=migrationSql(name);
    sqlite.exec(sql);
    sqlite.prepare('INSERT INTO movement_migrations VALUES(?,?)').run(name,digest(sql));
  }
  return sqlite;
}

function seedProfile(sqlite,user='alice',now=Date.parse('2026-10-20T12:00:00Z')){
  sqlite.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at) VALUES(?,?,?,?)').run(user,user,'UTC',now);
}

function eventStatement(db,user,eventId,occurredAt,localDate,receivedAt=occurredAt){
  return db.prepare('INSERT INTO repetition_events(user_id,id,occurred_at,local_date,received_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING').bind(user,eventId,occurredAt,localDate,receivedAt);
}

test('clean migration creates the activity/workout schema and restart preserves its activation and migration hashes',async t=>{
  const path=temporaryDatabase(t),before=Date.now();
  let db=openDatabase(path);
  const settings=await db.prepare('SELECT * FROM activity_settings WHERE id=1').first();
  assert.ok(Number.isSafeInteger(settings.activated_at));
  assert.ok(settings.activated_at>=before-1000&&settings.activated_at<=Date.now()+1000);
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(row=>row.name);
  for(const name of ['workout_sessions','workout_steps','workout_events','activity_settings','activity_events','activity_event_parts','activity_days','activity_totals'])assert.ok(tables.includes(name),name);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  const applied=(await db.prepare('SELECT name,sha256 FROM movement_migrations ORDER BY name').all()).results;
  assert.deepEqual(applied.map(row=>row.name),migrationNames());
  for(const row of applied)assert.equal(row.sha256,digest(migrationSql(row.name)));
  db.close();
  db=openDatabase(path);
  try{
    assert.deepEqual(await db.prepare('SELECT * FROM activity_settings WHERE id=1').first(),settings);
    assert.deepEqual((await db.prepare('SELECT name,sha256 FROM movement_migrations ORDER BY name').all()).results,applied);
  }finally{db.close();}
});

test('upgrade keeps populated profiles, guest credentials, rewards, rounds and aggregate rows without retroactive XP',async t=>{
  const path=temporaryDatabase(t),sqlite=existingDatabase(path),now=Date.parse('2026-10-20T12:00:00Z');
  seedProfile(sqlite,'alice',now);seedProfile(sqlite,'bob',now);
  sqlite.prepare('INSERT INTO device_sessions(token_hash,user_id,created_at) VALUES(?,?,?)').run('a'.repeat(64),'guest-without-profile',now);
  const competition=id(),completed=id(),aborted=id();
  sqlite.prepare('INSERT INTO competitions(id,creator_id,opponent_id,token_hash,create_request_id,rules_version,created_at,accepted_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(competition,'alice','bob','b'.repeat(64),id(),'squat-v1',now-60000,now-60000,now+86400000);
  for(const [round,status,count] of [[completed,'completed',12],[aborted,'aborted',4]])sqlite.prepare("INSERT INTO rounds(id,user_id,start_request_id,kind,competition_id,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,'competition',?,'squat-v1',?,?,?,?,?)").run(round,'alice',id(),competition,status,now-60000,now,now,count);
  for(let i=0;i<10;i++)sqlite.prepare('INSERT INTO repetition_events(user_id,id,occurred_at,local_date,received_at) VALUES(?,?,?,?,?)').run('alice',id(),now,'2026-10-20',now);
  sqlite.prepare("INSERT INTO weekly_bonuses(user_id,week,type,points,awarded_at,basis) VALUES(?,'2026-10-19','full_week',20,?,?)").run('alice',now,'migration-fixture');
  const names=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='movement_migrations' ORDER BY name").all().map(row=>row.name);
  const original=new Map(names.map(name=>[name,plain(sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())]));
  const hashes=plain(sqlite.prepare('SELECT * FROM movement_migrations ORDER BY name').all());
  assert.equal(sqlite.prepare('SELECT points FROM user_totals WHERE user_id=?').get('alice').points,30);
  sqlite.close();
  const db=openDatabase(path);
  try{
    for(const name of names)assert.deepEqual(plain((await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results),original.get(name),name);
    for(const previous of hashes)assert.deepEqual(plain(await db.prepare('SELECT * FROM movement_migrations WHERE name=?').bind(previous.name).first()),previous);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_events').first()).n,0);
    assert.equal((await db.prepare('SELECT COALESCE(SUM(total_xp),0) AS n FROM activity_totals').first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_days').first()).n,0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{db.close();}
});

test('legacy insertion mirrors once and gives XP by activity time on the activation boundary',async t=>{
  const db=openDatabase(temporaryDatabase(t));
  t.after(()=>db.close());
  const activatedAt=Date.parse('2026-10-26T12:00:00Z');
  await db.prepare('UPDATE activity_settings SET activated_at=? WHERE id=1').bind(activatedAt).run();
  await db.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at) VALUES(?,?,?,?)').bind('alice','Alice','UTC',activatedAt).run();
  const before=id(),eligible=id();
  await eventStatement(db,'alice',before,activatedAt-1,'2026-10-26',activatedAt+100).run();
  await eventStatement(db,'alice',eligible,activatedAt,'2026-10-26',activatedAt+100).run();
  await eventStatement(db,'alice',eligible,activatedAt,'2026-10-26',activatedAt+1000).run();
  assert.equal((await db.prepare('SELECT count FROM daily_progress WHERE user_id=? AND local_date=?').bind('alice','2026-10-26').first()).count,2);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_events WHERE user_id=?').bind('alice').first()).n,2);
  assert.equal((await db.prepare('SELECT xp FROM activity_days WHERE user_id=? AND local_date=?').bind('alice','2026-10-26').first()).xp,1);
  assert.equal((await db.prepare('SELECT total_xp FROM activity_totals WHERE user_id=?').bind('alice').first()).total_xp,1);
});

test('a failed batch rolls legacy, activity, progress and rewards back together and can be retried',async t=>{
  const db=openDatabase(temporaryDatabase(t));
  t.after(()=>db.close());
  const now=Date.parse('2026-10-26T12:00:00Z');
  await db.prepare('UPDATE activity_settings SET activated_at=? WHERE id=1').bind(now).run();
  await db.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at) VALUES(?,?,?,?)').bind('alice','Alice','UTC',now).run();
  const valid=Array.from({length:10},()=>eventStatement(db,'alice',id(),now,'2026-10-26'));
  await assert.rejects(db.batch([...valid,eventStatement(db,'missing-profile',id(),now,'2026-10-26')]),/FOREIGN KEY/);
  for(const table of ['repetition_events','daily_progress','daily_rewards','activity_events','activity_event_parts','activity_days'])assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,0,table);
  assert.equal((await db.prepare('SELECT total_xp FROM activity_totals WHERE user_id=?').bind('alice').first()).total_xp,0);
  await db.batch(valid);
  assert.equal((await db.prepare('SELECT count FROM daily_progress WHERE user_id=?').bind('alice').first()).count,10);
  assert.equal((await db.prepare('SELECT points FROM daily_rewards WHERE user_id=?').bind('alice').first()).points,10);
  assert.equal((await db.prepare('SELECT total_xp FROM activity_totals WHERE user_id=?').bind('alice').first()).total_xp,10);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});

test('the ordinary migrator still rejects a changed applied migration instead of silently rebuilding user data',t=>{
  const path=temporaryDatabase(t),sqlite=existingDatabase(path);
  seedProfile(sqlite);
  sqlite.prepare('UPDATE movement_migrations SET sha256=? WHERE name=?').run('0'.repeat(64),'0000_squat_mvp.sql');
  sqlite.close();
  assert.throws(()=>openDatabase(path),/Applied migration changed: 0000_squat_mvp\.sql/);
  const check=new DatabaseSync(path);
  try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM profiles').get().n,1);}
  finally{check.close();}
});
