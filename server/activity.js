import {dateAt,addDays} from './weeks.js';

const row=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
export const ACTIVITY_RULES_VERSION='activity-v1';

/** Partition a validated hold at actual local date boundaries (including DST). */
export function activityParts(event,exercise,timeZone,activatedAt){
  if(exercise!=='plank')return [{date:dateAt(event.occurredAt,timeZone),squats:exercise==='squat'?1:0,pushups:exercise==='pushup'?1:0,plankMs:0,xpSquats:exercise==='squat'&&event.occurredAt>=activatedAt?1:0,xpPushups:exercise==='pushup'&&event.occurredAt>=activatedAt?1:0,xpPlankMs:0}];
  const result=[];let start=event.occurredAt;const finish=start+event.durationMs;
  while(start<finish){
    const date=dateAt(start,timeZone);let end=finish;
    if(dateAt(finish-1,timeZone)!==date){
      let low=start+1,high=finish;
      while(low<high){const middle=Math.floor((low+high)/2);if(dateAt(middle,timeZone)===date)low=middle+1;else high=middle;}
      end=low;
    }
    result.push({date,squats:0,pushups:0,plankMs:end-start,xpSquats:0,xpPushups:0,xpPlankMs:Math.max(0,end-Math.max(start,activatedAt))});
    start=end;
  }
  return result;
}

/** Ledger-driven progress; historical squat days restore streak without retro XP. */
export async function readActivity(db,userId,now){
  const profile=await row(db,'SELECT time_zone FROM profiles WHERE user_id=?',userId);
  const today=dateAt(now,profile.time_zone);
  const snapshot=await db.batch([
    db.prepare('SELECT activated_at FROM activity_settings WHERE id=1'),
    db.prepare(`SELECT a.total_xp,a.revision+u.revision AS version FROM activity_totals a JOIN user_totals u ON u.user_id=a.user_id WHERE a.user_id=?`).bind(userId),
    db.prepare(`WITH dates AS (SELECT local_date FROM daily_progress WHERE user_id=? UNION SELECT local_date FROM activity_days WHERE user_id=?)
      SELECT d.local_date AS date,COALESCE(p.count,a.squats,0) AS squats,COALESCE(a.pushups,0) AS pushups,
        COALESCE(a.plank_ms,0) AS plankMs,COALESCE(a.xp,0) AS xp
      FROM dates d LEFT JOIN daily_progress p ON p.user_id=? AND p.local_date=d.local_date
      LEFT JOIN activity_days a ON a.user_id=? AND a.local_date=d.local_date
      WHERE d.local_date<=? ORDER BY d.local_date`).bind(userId,userId,userId,userId,today),
  ]);
  const settings=snapshot[0].results[0],total=snapshot[1].results[0];
  const days=snapshot[2].results.map(day=>({...day,units:day.squats+day.pushups+Math.floor(day.plankMs/5000)}));
  const qualified=days.filter(day=>day.units>=10),dates=new Set(qualified.map(day=>day.date));
  let best=0,run=0,previous=null;
  for(const day of qualified){run=previous&&addDays(previous,1)===day.date?run+1:1;best=Math.max(best,run);previous=day.date;}
  let date=dates.has(today)?today:addDays(today,-1),current=0;
  while(dates.has(date)){current++;date=addDays(date,-1);}
  const day=days.find(value=>value.date===today)??{date:today,squats:0,pushups:0,plankMs:0,units:0,xp:0};
  return {rulesVersion:ACTIVITY_RULES_VERSION,activatedAt:settings.activated_at,version:total.version,totalXp:total.total_xp,
    level:1+Math.floor(total.total_xp/100),xpInLevel:total.total_xp%100,xpForNextLevel:100,
    today:{...day,goal:10,completed:day.units>=10},streak:{current,best},serverNow:now};
}
