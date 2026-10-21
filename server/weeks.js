import {RULES_VERSION, ROUND_MS, DELIVERY_GRACE_MS, EVENT_RETENTION_MS} from './rules.js';

export const SPORTS_ZONE='Africa/Johannesburg';
export const WEEKLY_RULES_VERSION=RULES_VERSION;
const DAY=86_400_000, WEEK=7*DAY;
const row=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const rows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
export function dateAt(now,zone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const part=type=>parts.find(p=>p.type===type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function addDays(date,n){return new Date(Date.parse(`${date}T12:00:00Z`)+n*DAY).toISOString().slice(0,10);}
export function monday(date){const d=new Date(`${date}T12:00:00Z`);return addDays(date,-((d.getUTCDay()+6)%7));}
export const sportsWeek=now=>monday(dateAt(now,SPORTS_ZONE));
export function weekWindow(week){const start=Date.parse(`${week}T00:00:00+02:00`);return {week,startsAt:start,endsAt:start+WEEK};}
export function validWeek(week){return typeof week==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(week)&&Number.isFinite(Date.parse(`${week}T12:00:00Z`))&&addDays(week,0)===week&&monday(week)===week;}
const dateWeek="date(local_date, '-6 days', 'weekday 1')";
const bonusPoints="CASE place WHEN 1 THEN 20 WHEN 2 THEN 10 WHEN 3 THEN 5 END";
const bestSQL=`SELECT user_id,MAX(count) AS score FROM rounds WHERE status='completed' AND kind IN ('personal','competition') AND count>0 AND ends_at-starts_at=${ROUND_MS} AND rules_version=? AND ends_at>=? AND ends_at<? GROUP BY user_id`;

// Only server time creates periods. Settings are insert-once, never reset by a
// deployment. Existing daily rewards remain their original source of truth.
export async function maintainWeeks(db,now) {
  await db.prepare('INSERT INTO weekly_settings(id,activated_at,activation_week) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING').bind(now,sportsWeek(now)).run();
  const settings=await row(db,'SELECT * FROM weekly_settings WHERE id=1');
  const current=sportsWeek(now);
  const latest=await row(db,'SELECT MAX(week) AS week FROM weekly_periods');
  // Existing periods are immutable. Only append missing weeks, rather than
  // issuing a redundant INSERT for every historical week on every request.
  for(let week=latest?.week?addDays(latest.week,7):settings.activation_week;week<=current;week=addDays(week,7)) {
    const {startsAt,endsAt}=weekWindow(week);
    await db.prepare('INSERT INTO weekly_periods(week,starts_at,ends_at,rules_version) VALUES(?,?,?,?) ON CONFLICT(week) DO NOTHING').bind(week,startsAt,endsAt,WEEKLY_RULES_VERSION).run();
  }
  const closing=await rows(db,'SELECT * FROM weekly_periods WHERE closed_at IS NULL AND ends_at+?<? ORDER BY week',DELIVERY_GRACE_MS,now);
  for(const period of closing) {
    // One D1 transaction: expire, snapshot ranks (RANK, not ROW_NUMBER), award,
    // close. A second request observes either the entire close or none of it.
    await db.batch([
      db.prepare("UPDATE rounds SET status='aborted',finished_at=ends_at WHERE status='active' AND ends_at+?<?").bind(DELIVERY_GRACE_MS,now),
      db.prepare(`INSERT INTO weekly_participants(week,user_id) SELECT ?,user_id FROM profiles WHERE rankings_excluded=0 AND created_at<?
        AND EXISTS(SELECT 1 FROM weekly_periods WHERE week=? AND closed_at IS NULL) ON CONFLICT(week,user_id) DO NOTHING`).bind(period.week,period.ends_at,period.week),
      db.prepare(`INSERT INTO weekly_standings(week,user_id,score,place)
        SELECT ?,b.user_id,b.score,RANK() OVER(ORDER BY b.score DESC) FROM (${bestSQL}) b JOIN profiles p ON p.user_id=b.user_id
        WHERE p.rankings_excluded=0 AND EXISTS(SELECT 1 FROM weekly_periods WHERE week=? AND closed_at IS NULL)
        ON CONFLICT(week,user_id) DO NOTHING`).bind(period.week,period.rules_version,period.starts_at,period.ends_at,period.week),
      db.prepare(`INSERT INTO weekly_bonuses(user_id,week,type,points,awarded_at,basis)
        SELECT user_id,week,'sport_place',${bonusPoints},?,'sport:'||week||':'||user_id FROM weekly_standings
        WHERE week=? AND place<=3 AND EXISTS(SELECT 1 FROM weekly_periods WHERE week=? AND closed_at IS NULL)
        ON CONFLICT(user_id,week,type) DO NOTHING`).bind(now,period.week,period.week),
      db.prepare('UPDATE weekly_periods SET closed_at=? WHERE week=? AND closed_at IS NULL').bind(now,period.week),
    ]);
  }
  await reconcileRewards(db,now,settings.activation_week);
  return settings;
}

export async function reconcileRewards(db,now,activationWeek=null) {
  activationWeek??=(await row(db,'SELECT activation_week FROM weekly_settings WHERE id=1'))?.activation_week;
  if(!activationWeek)return;
  // Exactly seven different local calendar dates, not the rolling last7.
  // This scans all users, including people who have not opened the app lately.
  await db.prepare(`INSERT INTO weekly_bonuses(user_id,week,type,points,awarded_at,basis)
    SELECT user_id,${dateWeek},'full_week',20,?,'full:'||${dateWeek}||':'||user_id FROM daily_rewards
    WHERE local_date>=? GROUP BY user_id,${dateWeek} HAVING COUNT(DISTINCT local_date)=7
    ON CONFLICT(user_id,week,type) DO NOTHING`).bind(now,activationWeek).run();
  // Persist personal summaries; later daily synchronization updates the same
  // summary, retaining seen_at. A revised balance never re-awards a bonus.
  await db.prepare(`INSERT INTO weekly_summaries(user_id,week,completed_days,best,sport_place,participated,daily_points,full_week_points,sport_points,total,updated_at)
    SELECT p.user_id,w.week,
      (SELECT COUNT(*) FROM daily_rewards d WHERE d.user_id=p.user_id AND d.local_date>=w.week AND d.local_date<date(w.week,'+7 days')),
      (SELECT MAX(r.count) FROM rounds r WHERE r.user_id=p.user_id AND r.status='completed' AND r.kind IN ('personal','competition') AND r.count>0 AND r.ends_at-r.starts_at=${ROUND_MS} AND r.rules_version=w.rules_version AND r.ends_at>=w.starts_at AND r.ends_at<w.ends_at),
      s.place,CASE WHEN EXISTS(SELECT 1 FROM weekly_participants wp WHERE wp.user_id=p.user_id AND wp.week=w.week) THEN 1 ELSE 0 END,
      COALESCE((SELECT SUM(d.points) FROM daily_rewards d WHERE d.user_id=p.user_id AND d.local_date>=w.week AND d.local_date<date(w.week,'+7 days')),0),
      COALESCE((SELECT SUM(b.points) FROM weekly_bonuses b WHERE b.user_id=p.user_id AND b.week=w.week AND b.type='full_week'),0),
      COALESCE((SELECT SUM(b.points) FROM weekly_bonuses b WHERE b.user_id=p.user_id AND b.week=w.week AND b.type='sport_place'),0),
      COALESCE((SELECT SUM(d.points) FROM daily_rewards d WHERE d.user_id=p.user_id AND d.local_date>=w.week AND d.local_date<date(w.week,'+7 days')),0)+COALESCE((SELECT SUM(b.points) FROM weekly_bonuses b WHERE b.user_id=p.user_id AND b.week=w.week),0),?
    FROM profiles p CROSS JOIN weekly_periods w LEFT JOIN weekly_standings s ON s.user_id=p.user_id AND s.week=w.week
    WHERE w.closed_at IS NOT NULL AND p.created_at<w.ends_at
    ON CONFLICT(user_id,week) DO UPDATE SET completed_days=excluded.completed_days,best=excluded.best,sport_place=excluded.sport_place,participated=excluded.participated,
      daily_points=excluded.daily_points,full_week_points=excluded.full_week_points,sport_points=excluded.sport_points,total=excluded.total,updated_at=excluded.updated_at,revision=weekly_summaries.revision+1
    WHERE weekly_summaries.completed_days!=excluded.completed_days OR weekly_summaries.best IS NOT excluded.best OR weekly_summaries.sport_place IS NOT excluded.sport_place OR weekly_summaries.total!=excluded.total`).bind(now).run();
}

async function resultEntries(db,period) {
  if(period.closed_at!==null)return rows(db,`SELECT s.user_id,p.display_name AS name,s.score AS value,s.place FROM weekly_standings s JOIN profiles p ON p.user_id=s.user_id WHERE s.week=? AND p.rankings_excluded=0 ORDER BY s.place,p.display_name,s.user_id`,period.week);
  return rows(db,`SELECT b.user_id,p.display_name AS name,b.score AS value,RANK() OVER(ORDER BY b.score DESC) AS place FROM (${bestSQL}) b JOIN profiles p ON p.user_id=b.user_id WHERE p.rankings_excluded=0 ORDER BY b.score DESC,p.display_name,b.user_id`,period.rules_version,period.starts_at,period.ends_at);
}
async function pointEntries(db,week=null) {
  return rows(db,`SELECT user_id,name,value,RANK() OVER(ORDER BY value DESC) AS place FROM (
    SELECT p.user_id,p.display_name AS name,
      COALESCE((SELECT SUM(d.points) FROM daily_rewards d WHERE d.user_id=p.user_id ${week?'AND d.local_date>=? AND d.local_date<?':''}),0)+
      COALESCE((SELECT SUM(b.points) FROM weekly_bonuses b WHERE b.user_id=p.user_id ${week?'AND b.week=?':''}),0) AS value
    FROM profiles p WHERE p.rankings_excluded=0) ORDER BY value DESC,name,user_id`,...(week?[week,addDays(week,7),week]:[]));
}
const publicEntry=(entry,userId)=>({place:entry.place,name:entry.name,value:entry.value,isYou:entry.user_id===userId});
const periodView=p=>({week:p.week,startsAt:p.starts_at,endsAt:p.ends_at,rulesVersion:p.rules_version,closed:p.closed_at!==null});
export async function leaderboard(db,userId,{type='result',period='week',week},now) {
  await maintainWeeks(db,now);
  week??=sportsWeek(now);
  const selected=await row(db,'SELECT * FROM weekly_periods WHERE week=?',week);
  if(!selected)return null;
  const entries=type==='result'?await resultEntries(db,selected):await pointEntries(db,period==='all'?null:week);
  return {type,period,week:selected.week,periodInfo:periodView(selected),serverNow:now,timeZone:SPORTS_ZONE,
    pointsMayUpdate:type==='points'&&(period==='all'||now<selected.ends_at+EVENT_RETENTION_MS+2*DAY),
    entries:entries.slice(0,200).map(e=>publicEntry(e,userId)),totalParticipants:entries.length,
    you:entries.find(e=>e.user_id===userId)?publicEntry(entries.find(e=>e.user_id===userId),userId):null};
}

async function breakdown(db,userId,week) {
  const d=await row(db,'SELECT COUNT(*) AS days,COALESCE(SUM(points),0) AS points FROM daily_rewards WHERE user_id=? AND local_date>=? AND local_date<?',userId,week,addDays(week,7));
  const b=await rows(db,'SELECT type,points FROM weekly_bonuses WHERE user_id=? AND week=?',userId,week);
  const fullWeek=b.find(x=>x.type==='full_week')?.points??0,sport=b.find(x=>x.type==='sport_place')?.points??0;
  return {completedDays:d.days,daily:d.points,fullWeek,sport,total:d.points+fullWeek+sport};
}
export async function weeklyState(db,userId,profile,now) {
  const settings=await row(db,'SELECT * FROM weekly_settings WHERE id=1');
  const periods=await rows(db,'SELECT * FROM weekly_periods ORDER BY week DESC');
  const localToday=dateAt(now,profile.time_zone),localWeek=monday(localToday),current=sportsWeek(now);
  const daily=await rows(db,'SELECT local_date FROM daily_rewards WHERE user_id=? AND local_date>=? AND local_date<?',userId,localWeek,addDays(localWeek,7));
  const completed=new Set(daily.map(d=>d.local_date));
  const dates=Array.from({length:7},(_,i)=>{const date=addDays(localWeek,i);return {date,completed:completed.has(date),past:date<localToday,today:date===localToday};});
  const missed=dates.some(d=>d.past&&!d.completed);
  const period=periods.find(p=>p.week===current);
  const result=!profile.rankings_excluded&&period?(await resultEntries(db,period)).find(r=>r.user_id===userId):null;
  const points=!profile.rankings_excluded?(await pointEntries(db,current)).find(r=>r.user_id===userId):null;
  const summaries=await rows(db,'SELECT s.*,w.ends_at,w.rules_version FROM weekly_summaries s JOIN weekly_periods w ON w.week=s.week WHERE user_id=? ORDER BY s.week DESC',userId);
  return {activationWeek:settings.activation_week,sportsWeek:current,timeZone:SPORTS_ZONE,periods:periods.map(periodView),
    yourWeek:{week:localWeek,dates,completedDays:completed.size,remaining:7-completed.size,possible:!missed,canSyncPast:missed,points:await breakdown(db,userId,localWeek)},
    places:{result:result?{place:result.place,value:result.value}:null,points:points?{place:points.place,value:points.value}:null},
    summaries:summaries.map(s=>({week:s.week,completedDays:s.completed_days,best:s.best,place:s.sport_place,participated:!!s.participated,
      points:{daily:s.daily_points,fullWeek:s.full_week_points,sport:s.sport_points,total:s.total},revision:s.revision,seen:s.seen_at!==null,
      updatedSinceSeen:s.seen_at!==null&&s.total!==(s.seen_total??s.total),rulesVersion:s.rules_version,
      pointsMayUpdate:now<s.ends_at+EVENT_RETENTION_MS+2*DAY}))};
}

export async function acknowledgeWeek(db,userId,week,total,now) {
  // Ack only the rendered amount, so a concurrent late reward remains marked
  // as an update. The caller can never acknowledge another person's summary.
  await db.prepare('UPDATE weekly_summaries SET seen_at=COALESCE(seen_at,?),seen_total=? WHERE user_id=? AND week=? AND total=?').bind(now,total,userId,week,total).run();
}
