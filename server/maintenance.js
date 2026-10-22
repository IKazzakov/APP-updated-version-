import {sportsWeek,weekWindow,addDays,SPORTS_ZONE} from './weeks.js';
import {RULES_VERSION,DELIVERY_GRACE_MS} from './rules.js';
const row=(db,sql,...a)=>db.prepare(sql).bind(...a).first();
const rows=async(db,sql,...a)=>(await db.prepare(sql).bind(...a).all()).results;

// Request initialization touches a single setting and the current period only.
export async function ensureCurrentWeek(db,now){
  let settings=await row(db,'SELECT * FROM weekly_settings WHERE id=1');
  if(!settings){await db.prepare('INSERT INTO weekly_settings VALUES(1,?,?) ON CONFLICT(id) DO NOTHING').bind(now,sportsWeek(now)).run();settings=await row(db,'SELECT * FROM weekly_settings WHERE id=1');}
  const week=sportsWeek(now),period=await row(db,'SELECT week FROM weekly_periods WHERE week=?',week);
  if(!period){const p=weekWindow(week);await db.prepare('INSERT INTO weekly_periods(week,starts_at,ends_at,rules_version) VALUES(?,?,?,?) ON CONFLICT(week) DO NOTHING').bind(week,p.startsAt,p.endsAt,RULES_VERSION).run();}
  return settings;
}

// All data-dependent statements below are scoped to one user and one week.
export async function reconcileUserWeek(db,userId,week,now,revision=null){
  await db.batch([
    db.prepare(`INSERT INTO weekly_bonuses(user_id,week,type,points,awarded_at,basis)
      SELECT ?,?,'full_week',20,?,'full:'||?||':'||? WHERE ? >= (SELECT activation_week FROM weekly_settings WHERE id=1)
      AND (SELECT COUNT(*) FROM daily_rewards WHERE user_id=? AND local_date>=? AND local_date<date(?,'+7 days'))=7
      ON CONFLICT(user_id,week,type) DO NOTHING`).bind(userId,week,now,week,userId,week,userId,week,week),
    db.prepare(`INSERT INTO weekly_summaries(user_id,week,completed_days,best,sport_place,participated,daily_points,full_week_points,sport_points,total,updated_at)
      SELECT p.user_id,w.week,
        (SELECT COUNT(*) FROM daily_rewards d WHERE d.user_id=p.user_id AND d.local_date>=w.week AND d.local_date<date(w.week,'+7 days')),
        (SELECT score FROM weekly_best b WHERE b.user_id=p.user_id AND b.week=w.week AND b.rules_version=w.rules_version),s.place,
        CASE WHEN EXISTS(SELECT 1 FROM weekly_participants wp WHERE wp.user_id=p.user_id AND wp.week=w.week) THEN 1 ELSE 0 END,
        COALESCE((SELECT SUM(points) FROM daily_rewards d WHERE d.user_id=p.user_id AND d.local_date>=w.week AND d.local_date<date(w.week,'+7 days')),0),
        COALESCE((SELECT points FROM weekly_bonuses b WHERE b.user_id=p.user_id AND b.week=w.week AND b.type='full_week'),0),
        COALESCE((SELECT points FROM weekly_bonuses b WHERE b.user_id=p.user_id AND b.week=w.week AND b.type='sport_place'),0),
        COALESCE((SELECT points FROM week_points wp WHERE wp.user_id=p.user_id AND wp.week=w.week),0),?
      FROM profiles p JOIN weekly_periods w ON w.week=? LEFT JOIN weekly_standings s ON s.user_id=p.user_id AND s.week=w.week
      WHERE p.user_id=? AND w.closed_at IS NOT NULL AND p.created_at<w.ends_at
      ON CONFLICT(user_id,week) DO UPDATE SET completed_days=excluded.completed_days,best=excluded.best,sport_place=excluded.sport_place,participated=excluded.participated,
        daily_points=excluded.daily_points,full_week_points=excluded.full_week_points,sport_points=excluded.sport_points,total=excluded.total,updated_at=excluded.updated_at,revision=weekly_summaries.revision+1
      WHERE weekly_summaries.completed_days!=excluded.completed_days OR weekly_summaries.best IS NOT excluded.best OR weekly_summaries.sport_place IS NOT excluded.sport_place OR weekly_summaries.total!=excluded.total OR weekly_summaries.participated!=excluded.participated`).bind(now,week,userId),
    // A concurrent new event changes revision; its work must remain queued.
    db.prepare('DELETE FROM weekly_dirty WHERE user_id=? AND week=? AND revision=?').bind(userId,week,revision??-1),
  ]);
}
export async function reconcileUser(db,userId,now,{limit=4}={}){
  const jobs=await rows(db,'SELECT * FROM weekly_dirty WHERE user_id=? ORDER BY week DESC LIMIT ?',userId,limit);
  for(const job of jobs)await reconcileUserWeek(db,userId,job.week,now,job.revision);
  return jobs.length;
}

export async function runMaintenance(db,now,{userLimit=100,periodLimit=4}={}){
  userLimit=Math.min(500,Math.max(1,userLimit));periodLimit=Math.min(8,Math.max(1,periodLimit));
  const settings=await ensureCurrentWeek(db,now),current=sportsWeek(now);
  for(let i=0;i<periodLimit;i++){
    const first=await row(db,'SELECT week FROM weekly_periods WHERE week=?',settings.activation_week);
    const missing=!first?{week:settings.activation_week}:await row(db,"SELECT date(w.week,'+7 days') AS week FROM weekly_periods w WHERE w.week<? AND NOT EXISTS(SELECT 1 FROM weekly_periods n WHERE n.week=date(w.week,'+7 days')) ORDER BY w.week LIMIT 1",current);
    if(!missing)break;const p=weekWindow(missing.week);
    await db.prepare('INSERT INTO weekly_periods(week,starts_at,ends_at,rules_version) VALUES(?,?,?,?) ON CONFLICT(week) DO NOTHING').bind(p.week,p.startsAt,p.endsAt,RULES_VERSION).run();
  }
  await db.prepare("UPDATE rounds SET status='aborted',finished_at=ends_at WHERE id IN(SELECT id FROM rounds WHERE status='active' AND ends_at<? LIMIT ?)").bind(now-DELIVERY_GRACE_MS,userLimit).run();
  const closing=await rows(db,'SELECT * FROM weekly_periods WHERE closed_at IS NULL AND ends_at<? ORDER BY week LIMIT ?',now-DELIVERY_GRACE_MS,periodLimit);
  for(const p of closing){
    // Consent is evaluated at the delivery cutoff, not at a delayed cron run.
    const eligible=`SELECT p.user_id FROM profiles p WHERE p.created_at<? AND COALESCE((SELECT excluded FROM ranking_consent c WHERE c.user_id=p.user_id AND c.changed_at<=? ORDER BY c.changed_at DESC LIMIT 1),p.rankings_excluded)=0`;
    await db.batch([
      db.prepare(`INSERT INTO weekly_participants(week,user_id) SELECT ?,user_id FROM (${eligible}) WHERE EXISTS(SELECT 1 FROM weekly_periods WHERE week=? AND closed_at IS NULL) ON CONFLICT(week,user_id) DO NOTHING`).bind(p.week,p.ends_at,p.ends_at+DELIVERY_GRACE_MS,p.week),
      db.prepare(`INSERT INTO weekly_standings(week,user_id,score,place)
        SELECT ?,b.user_id,b.score,RANK() OVER(ORDER BY b.score DESC) FROM weekly_best b JOIN weekly_participants wp ON wp.user_id=b.user_id AND wp.week=b.week
        WHERE b.week=? AND b.rules_version=? AND EXISTS(SELECT 1 FROM weekly_periods WHERE week=? AND closed_at IS NULL) ON CONFLICT(week,user_id) DO NOTHING`).bind(p.week,p.week,p.rules_version,p.week),
      db.prepare(`INSERT INTO weekly_bonuses(user_id,week,type,points,awarded_at,basis)
        SELECT user_id,week,'sport_place',CASE place WHEN 1 THEN 20 WHEN 2 THEN 10 WHEN 3 THEN 5 END,?,'sport:'||week||':'||user_id FROM weekly_standings
        WHERE week=? AND place<=3 AND EXISTS(SELECT 1 FROM weekly_periods WHERE week=? AND closed_at IS NULL) ON CONFLICT(user_id,week,type) DO NOTHING`).bind(now,p.week,p.week),
      db.prepare('UPDATE weekly_periods SET closed_at=? WHERE week=? AND closed_at IS NULL').bind(now,p.week),
    ]);
  }
  // Bounded backfill creates zero-activity summaries too, without CROSS JOIN.
  let remaining=userLimit;
  const periods=await rows(db,'SELECT * FROM weekly_periods WHERE closed_at IS NOT NULL AND summaries_complete=0 ORDER BY week LIMIT ?',periodLimit);
  for(const p of periods){
    if(!remaining)break;
    const users=await rows(db,'SELECT user_id FROM profiles WHERE user_id>? AND created_at<? ORDER BY user_id LIMIT ?',p.summary_cursor,p.ends_at,remaining);
    for(const u of users)await reconcileUserWeek(db,u.user_id,p.week,now);
    const last=users.at(-1)?.user_id??p.summary_cursor;
    await db.prepare('UPDATE weekly_periods SET summary_cursor=?,summaries_complete=? WHERE week=? AND summary_cursor=?').bind(last,users.length<remaining?1:0,p.week,p.summary_cursor).run();
    remaining-=users.length;
  }
  const dirty=await rows(db,'SELECT * FROM weekly_dirty ORDER BY week,user_id LIMIT ?',userLimit);
  for(const job of dirty)await reconcileUserWeek(db,job.user_id,job.week,now,job.revision);
  const pending=!!(await row(db,"SELECT 1 AS n FROM weekly_periods WHERE (closed_at IS NULL AND ends_at<?) OR (closed_at IS NOT NULL AND summaries_complete=0) LIMIT 1",now-DELIVERY_GRACE_MS))||!!(await row(db,'SELECT 1 n FROM weekly_dirty LIMIT 1'))||!!(await row(db,"SELECT 1 n FROM weekly_periods w WHERE w.week<? AND NOT EXISTS(SELECT 1 FROM weekly_periods n WHERE n.week=date(w.week,'+7 days')) LIMIT 1",current));
  return {closed:closing.length,reconciled:dirty.length,pending,timeZone:SPORTS_ZONE};
}
