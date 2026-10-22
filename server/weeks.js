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
export {runMaintenance as maintainWeeks} from './maintenance.js';
import {ensureCurrentWeek} from './maintenance.js';

function resultQuery(period){
  if(period.closed_at!==null)return {sql:'SELECT s.user_id,p.display_name AS name,s.score AS value,s.place FROM weekly_standings s JOIN profiles p ON p.user_id=s.user_id WHERE s.week=? AND p.rankings_excluded=0',args:[period.week]};
  return {sql:'SELECT b.user_id,p.display_name AS name,b.score AS value,RANK() OVER(ORDER BY b.score DESC) AS place FROM weekly_best b JOIN profiles p ON p.user_id=b.user_id WHERE b.week=? AND b.rules_version=? AND p.rankings_excluded=0',args:[period.week,period.rules_version]};
}
// Keep zero-point participants in weekly point tables.
function pointsQuery(week=null){if(!week)return {sql:'SELECT t.user_id,p.display_name AS name,t.points AS value,RANK() OVER(ORDER BY t.points DESC) AS place FROM user_totals t JOIN profiles p ON p.user_id=t.user_id WHERE p.rankings_excluded=0',args:[]};return {sql:'SELECT p.user_id,p.display_name AS name,COALESCE(w.points,0) AS value,RANK() OVER(ORDER BY COALESCE(w.points,0) DESC) AS place FROM profiles p LEFT JOIN week_points w ON w.user_id=p.user_id AND w.week=? WHERE p.rankings_excluded=0',args:[week]};}
async function ownPlaces(db,userId,period,current){
  const result=period.closed_at!==null?await row(db,'SELECT score AS value,place FROM weekly_standings WHERE week=? AND user_id=?',period.week,userId):await row(db,`SELECT b.score AS value,1+(SELECT COUNT(*) FROM weekly_best o JOIN profiles p ON p.user_id=o.user_id WHERE o.week=b.week AND o.rules_version=b.rules_version AND o.score>b.score AND p.rankings_excluded=0) AS place FROM weekly_best b WHERE b.week=? AND b.rules_version=? AND b.user_id=?`,period.week,period.rules_version,userId);
  const mine=await row(db,'SELECT COALESCE((SELECT points FROM week_points WHERE week=? AND user_id=?),0) value',current,userId);
  const rank=await row(db,'SELECT 1+COUNT(*) place FROM week_points w JOIN profiles p ON p.user_id=w.user_id WHERE w.week=? AND w.points>? AND p.rankings_excluded=0',current,mine.value);
  return {result,points:{value:mine.value,place:rank.place}};
}
const publicEntry=(entry,userId)=>({place:entry.place,name:entry.name,value:entry.value,isYou:entry.user_id===userId});
const periodView=p=>({week:p.week,startsAt:p.starts_at,endsAt:p.ends_at,rulesVersion:p.rules_version,closed:p.closed_at!==null});
export async function leaderboard(db,userId,{type='result',period='week',week},now) {
  await ensureCurrentWeek(db,now);
  week??=sportsWeek(now);
  const selected=await row(db,'SELECT * FROM weekly_periods WHERE week=?',week);
  if(!selected)return null;
  const q=type==='result'?resultQuery(selected):pointsQuery(period==='all'?null:week);
  const snapshot=await db.batch([db.prepare(`SELECT * FROM (${q.sql}) ORDER BY place,name,user_id LIMIT 200`).bind(...q.args),db.prepare(`SELECT * FROM (${q.sql}) WHERE user_id=?`).bind(...q.args,userId),db.prepare(`SELECT COUNT(*) n FROM (${q.sql})`).bind(...q.args)]);
  const entries=snapshot[0].results,you=snapshot[1].results[0],total=snapshot[2].results[0].n;
  return {type,period,week:selected.week,periodInfo:periodView(selected),serverNow:now,timeZone:SPORTS_ZONE,
    pointsMayUpdate:type==='points'&&(period==='all'||now<selected.ends_at+EVENT_RETENTION_MS+2*DAY),
    entries:entries.map(e=>publicEntry(e,userId)),totalParticipants:total,
    you:you?publicEntry(you,userId):null};
}

async function breakdown(db,userId,week) {
  const d=await row(db,'SELECT COUNT(*) AS days,COALESCE(SUM(points),0) AS points FROM daily_rewards WHERE user_id=? AND local_date>=? AND local_date<?',userId,week,addDays(week,7));
  const b=await rows(db,'SELECT type,points FROM weekly_bonuses WHERE user_id=? AND week=?',userId,week);
  const fullWeek=b.find(x=>x.type==='full_week')?.points??0,sport=b.find(x=>x.type==='sport_place')?.points??0;
  return {completedDays:d.days,daily:d.points,fullWeek,sport,total:d.points+fullWeek+sport};
}
export async function weeklyState(db,userId,profile,now,{compact=false}={}) {
  const settings=await row(db,'SELECT * FROM weekly_settings WHERE id=1');
  const periods=await rows(db,'SELECT * FROM weekly_periods ORDER BY week DESC'+(compact?' LIMIT 12':''));
  const localToday=dateAt(now,profile.time_zone),localWeek=monday(localToday),current=sportsWeek(now);
  const daily=await rows(db,'SELECT local_date FROM daily_rewards WHERE user_id=? AND local_date>=? AND local_date<?',userId,localWeek,addDays(localWeek,7));
  const completed=new Set(daily.map(d=>d.local_date));
  const dates=Array.from({length:7},(_,i)=>{const date=addDays(localWeek,i);return {date,completed:completed.has(date),past:date<localToday,today:date===localToday};});
  const missed=dates.some(d=>d.past&&!d.completed);
  const period=periods.find(p=>p.week===current);
  const places=!profile.rankings_excluded&&period?await ownPlaces(db,userId,period,current):{result:null,points:null};
  const summaries=await rows(db,'SELECT s.*,w.ends_at,w.rules_version FROM weekly_summaries s JOIN weekly_periods w ON w.week=s.week WHERE user_id=? ORDER BY s.week DESC'+(compact?' LIMIT 4':''),userId);
  return {activationWeek:settings.activation_week,sportsWeek:current,timeZone:SPORTS_ZONE,periods:periods.map(periodView),
    yourWeek:{week:localWeek,dates,completedDays:completed.size,remaining:7-completed.size,possible:!missed,canSyncPast:missed,points:await breakdown(db,userId,localWeek)},
    places,
    summaries:summaries.map(s=>summaryView(s,now))};
}

export async function acknowledgeWeek(db,userId,week,total,now) {
  // Ack only the rendered amount, so a concurrent late reward remains marked
  // as an update. The caller can never acknowledge another person's summary.
  await db.prepare('UPDATE weekly_summaries SET seen_at=COALESCE(seen_at,?),seen_total=? WHERE user_id=? AND week=? AND total=?').bind(now,total,userId,week,total).run();
}

export const summaryView=(s,now)=>({week:s.week,completedDays:s.completed_days,best:s.best,place:s.sport_place,participated:!!s.participated,
  points:{daily:s.daily_points,fullWeek:s.full_week_points,sport:s.sport_points,total:s.total},revision:s.revision,seen:s.seen_at!==null,
  updatedSinceSeen:s.seen_at!==null&&s.total!==(s.seen_total??s.total),rulesVersion:s.rules_version,
  pointsMayUpdate:now<s.ends_at+EVENT_RETENTION_MS+2*DAY});
