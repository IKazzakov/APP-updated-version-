// D1-compatible adapter for the same API when hosted by Node / AI Studio.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export function openDatabase(path) {
  if(path!==':memory:')mkdirSync(dirname(resolve(path)),{recursive:true});
  const sqlite=new DatabaseSync(path);
  try{
    sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    sqlite.exec('CREATE TABLE IF NOT EXISTS movement_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
    const migrations=new URL('../drizzle/',import.meta.url);
    for(const name of readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort()){
      const sql=readFileSync(new URL(name,migrations),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
      const previous=sqlite.prepare('SELECT sha256 FROM movement_migrations WHERE name=?').get(name);
      if(previous){if(previous.sha256!==hash)throw new Error(`Applied migration changed: ${name}`);continue;}
      sqlite.exec('BEGIN IMMEDIATE');
      try{sqlite.exec(sql);sqlite.prepare('INSERT INTO movement_migrations VALUES(?,?)').run(name,hash);sqlite.exec('COMMIT');}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    }
  }catch(error){sqlite.close();throw error;}
  class Statement{
    constructor(sql,args=[]){this.sql=sql;this.args=args;}
    bind(...args){return new Statement(this.sql,args);}
    async first(column){const row=sqlite.prepare(this.sql).get(...this.args)??null;return column?row?.[column]??null:row;}
    async all(){return {success:true,results:sqlite.prepare(this.sql).all(...this.args)};}
    async run(){const result=sqlite.prepare(this.sql).run(...this.args);return {success:true,results:[],meta:{changes:Number(result.changes)}};}
  }
  return {
    prepare:sql=>new Statement(sql),
    async batch(statements){
      sqlite.exec('BEGIN IMMEDIATE');
      try{
        const result=statements.map(s=>({success:true,results:sqlite.prepare(s.sql).all(...s.args)}));
        sqlite.exec('COMMIT');return result;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
    close:()=>sqlite.close(),
  };
}
