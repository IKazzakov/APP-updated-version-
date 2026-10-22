import {ApiError,localDate,roundView,profileView,competitionView} from './api.js';
import {weeklyState,summaryView,addDays,validWeek} from './weeks.js';
import {reconcileUser,reconcileUserWeek} from './maintenance.js';
import {RULES_VERSION,DAILY_GOAL} from './rules.js';
const row=(db,sql,...a)=>db.prepare(sql).bind(...a).first();
const rows=async(db,sql,...a)=>(await db.prepare(sql).bind(...a).all()).results;
const empty=now=>({profile:null,today:null,days:[],points:0,last7:0,rounds:[],activeRound:null,competitions:[],serverNow:now,rulesVersion:RULES_VERSION,version:0});

async function recentSummaries(db,userId,now){
  const missing=await rows(db,'SELECT w.week FROM weekly_periods w JOIN profiles p ON p.user_id=? LEFT JOIN weekly_summaries s ON s.user_id=p.user_id AND s.week=w.week WHERE w.closed_at IS NOT NULL AND p.created_at<w.ends_at AND s.user_id IS NULL ORDER BY w.week DESC LIMIT 4',userId);
  for(const p of missing)await reconcileUserWeek(db,userId,p.week,now);
}
export async function readReceipt(db,userId,now){
  await reconcileUser(db,userId,now);
  const profile=await row(db,'SELECT * FROM profiles WHERE user_id=?',userId);
  if(!profile)throw new ApiError(409,'PROFILE_REQUIRED','Сначала сохраните профиль.');
  const date=localDate(now,profile.time_zone);
  const snapshot=await db.batch([
    db.prepare('SELECT points,bonus_points AS bonusPoints,revision AS version FROM user_totals WHERE user_id=?').bind(userId),
    db.prepare('SELECT local_date AS date,count FROM daily_progress WHERE user_id=? AND local_date>=? AND local_date<=? ORDER BY local_date DESC').bind(userId,addDays(date,-7),date),
    db.prepare("SELECT * FROM rounds WHERE user_id=? AND status='active'").bind(userId),
  ]);
  const total=snapshot[0].results[0],days=snapshot[1].results.map(d=>({...d,completed:d.count>=DAILY_GOAL})),count=days.find(d=>d.date===date)?.count||0;
  return {...total,partial:true,profile:profileView(profile),today:{date,count,goal:DAILY_GOAL,completed:count>=DAILY_GOAL},days,last7:days.filter(d=>d.completed&&d.date>=addDays(date,-6)).length,
    activeRound:snapshot[2].results[0]?roundView(snapshot[2].results[0]):null,serverNow:now,rulesVersion:RULES_VERSION};
}
export async function readDashboard(db,userId,now){
  const profile=await row(db,'SELECT * FROM profiles WHERE user_id=?',userId);
  if(!profile)return empty(now);
  await recentSummaries(db,userId,now);
  const receipt=await readReceipt(db,userId,now);
  const snapshot=await db.batch([
    db.prepare("SELECT * FROM rounds WHERE user_id=? AND status='completed' AND rules_version=? ORDER BY finished_at DESC,id DESC LIMIT 2").bind(userId,RULES_VERSION),
    db.prepare("SELECT count FROM rounds WHERE user_id=? AND status='completed' AND rules_version=? ORDER BY count DESC LIMIT 1").bind(userId,RULES_VERSION),
  ]);
  const {partial,...state}=receipt;
  return {...state,rounds:snapshot[0].results.map(roundView),competitions:[],stats:{record:snapshot[1].results[0]?.count??null},
    weekly:await weeklyState(db,userId,profile,now,{compact:true}),compact:true};
}

const fail=code=>{throw new ApiError(400,code,'Проверьте период и повторите загрузку.');};
function validDate(d){return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T12:00:00Z'))&&addDays(d,0)===d;}
function cursorEncode(value){return btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function cursorDecode(value,kind){
  if(!value)return null;if(value.length>512||!/^[a-zA-Z0-9_-]+$/.test(value))fail('INVALID_CURSOR');
  try{const c=JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/')));if(!c||c.kind!==kind||!Array.isArray(c.key))fail('INVALID_CURSOR');return c.key;}catch{fail('INVALID_CURSOR');}
}
export async function readPage(db,userId,kind,params,now){
  const profile=await row(db,'SELECT * FROM profiles WHERE user_id=?',userId);if(!profile)throw new ApiError(409,'PROFILE_REQUIRED','Сначала сохраните профиль.');
  const raw=params.get('limit')??'50';if(!/^\d{1,3}$/.test(raw)||Number(raw)<1||Number(raw)>(kind==='competitions'?50:100))fail('INVALID_LIMIT');
  const limit=Number(raw),key=cursorDecode(params.get('cursor'),kind),n=limit+1;
  let values;
  if(kind==='rounds'){
    if(key&&(!Number.isSafeInteger(key[0])||key[0]<0||typeof key[1]!=='string'||key[1].length>100||key.length!==2))fail('INVALID_CURSOR');
    values=await rows(db,"SELECT * FROM rounds WHERE user_id=? AND status='completed'"+(key?' AND (finished_at<? OR (finished_at=? AND id<?))':'')+' ORDER BY finished_at DESC,id DESC LIMIT ?',userId,...(key?[key[0],key[0],key[1]]:[]),n);
  }else if(kind==='progress'){
    const today=localDate(now,profile.time_zone),from=params.get('from')??addDays(today,-30),to=params.get('to')??today;
    if(!validDate(from)||!validDate(to)||from>to||Date.parse(to)-Date.parse(from)>366*86400000)fail('INVALID_RANGE');
    if(key&&(!validDate(key[0])||key.length!==1))fail('INVALID_CURSOR');
    values=await rows(db,'SELECT local_date AS date,count FROM daily_progress WHERE user_id=? AND local_date>=? AND local_date<=?'+(key?' AND local_date<?':'')+' ORDER BY local_date DESC LIMIT ?',userId,from,to,...(key?[key[0]]:[]),n);
  }else if(kind==='weeks'){
    if(key&&(!validWeek(key[0])||key.length!==1))fail('INVALID_CURSOR');
    values=await rows(db,'SELECT s.*,w.ends_at,w.rules_version FROM weekly_summaries s JOIN weekly_periods w ON w.week=s.week WHERE s.user_id=?'+(key?' AND s.week<?':'')+' ORDER BY s.week DESC LIMIT ?',userId,...(key?[key[0]]:[]),n);
  }else if(kind==='competitions'){
    if(key&&(!Number.isSafeInteger(key[0])||key[0]<0||typeof key[1]!=='string'||key[1].length>100||key.length!==2))fail('INVALID_CURSOR');
    values=await rows(db,'SELECT * FROM competitions WHERE (creator_id=? OR opponent_id=?)'+(key?' AND (created_at<? OR (created_at=? AND id<?))':'')+' ORDER BY created_at DESC,id DESC LIMIT ?',userId,userId,...(key?[key[0],key[0],key[1]]:[]),n);
  }else throw new ApiError(404,'NOT_FOUND','Страница не найдена.');
  const more=values.length>limit;values=values.slice(0,limit);let items;
  if(kind==='rounds')items=values.map(roundView);
  if(kind==='progress')items=values.map(d=>({...d,completed:d.count>=DAILY_GOAL}));
  if(kind==='weeks')items=values.map(s=>summaryView(s,now));
  if(kind==='competitions'){
    const ids=values.map(c=>c.id),members=[...new Set(values.flatMap(c=>[c.creator_id,c.opponent_id]).filter(Boolean))];
    const names=members.length?await rows(db,`SELECT user_id,display_name FROM profiles WHERE user_id IN (${members.map(()=>'?').join(',')})`,...members):[];
    const attempts=ids.length?await rows(db,`SELECT competition_id,user_id,status,count,rules_version,ends_at FROM rounds WHERE competition_id IN (${ids.map(()=>'?').join(',')})`,...ids):[];
    const active=await row(db,"SELECT id FROM rounds WHERE user_id=? AND status='active'",userId);
    items=await Promise.all(values.map(c=>competitionView(db,c,userId,now,{names,attempts,active})));
  }
  const last=values.at(-1),next=more?cursorEncode({kind,key:kind==='rounds'?[last.finished_at,last.id]:kind==='competitions'?[last.created_at,last.id]:[kind==='progress'?last.date:last.week]}):null;
  return {items,nextCursor:next,serverNow:now,limit};
}
