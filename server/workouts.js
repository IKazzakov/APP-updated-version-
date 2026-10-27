import {ApiError} from './api.js';
import {WORKOUT_PROGRAMS,WORKOUT_RULES_VERSION,findWorkoutProgram,expandWorkoutSteps} from '../src/shared/workouts/catalog.ts';
import {readActivity,activityParts} from './activity.js';
import {EVENT_RETENTION_MS} from './rules.js';

const DAY=86400000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const row=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const rows=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const fail=(status,code,message='Проверьте данные тренировки и повторите действие.')=>{throw new ApiError(status,code,message);};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(400,'INVALID_INPUT');}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail(400,'INVALID_ID');return value.toLowerCase();}
function validTime(value,now){return integer(value)&&value>=now-EVENT_RETENTION_MS&&value<=now+5000;}

/** SQL guards handle the same races as the preliminary user-facing checks. */
export function workoutDatabaseError(error){
  const codes=['REQUEST_REUSED','ACTIVE_WORKOUT','ACTIVE_ROUND','WORKOUT_CLOSED','WORKOUT_TARGET_EXCEEDED','WORKOUT_STEP_ORDER','ACTIVITY_INTERVAL_OVERLAP','INVALID_WORKOUT_DURATION','INVALID_WORKOUT_TIME'];
  const code=codes.find(value=>new RegExp(`\\b${value}\\b`).test(error.message??''));
  return code?new ApiError(['WORKOUT_TARGET_EXCEEDED','WORKOUT_STEP_ORDER','INVALID_WORKOUT_DURATION','INVALID_WORKOUT_TIME'].includes(code)?400:409,code,'Не удалось сохранить тренировку. Обновите данные и повторите действие.'):null;
}
export async function hasActiveWorkout(db,userId,now){
  return !!await row(db,"SELECT 1 FROM workout_sessions WHERE user_id=? AND status='active' AND started_at+?>=? LIMIT 1",userId,DAY,now);
}
async function profileFor(db,userId){const profile=await row(db,'SELECT * FROM profiles WHERE user_id=?',userId);if(!profile)fail(409,'PROFILE_REQUIRED','Сначала сохраните профиль.');return profile;}
async function ownedWorkout(db,userId,id){const workout=await row(db,'SELECT * FROM workout_sessions WHERE id=? AND user_id=?',id,userId);if(!workout)fail(404,'WORKOUT_NOT_FOUND','Тренировка не найдена.');return workout;}
async function view(db,workout,knownSteps=null){
  const steps=knownSteps??await rows(db,'SELECT progress FROM workout_steps WHERE workout_id=? ORDER BY step_index',workout.id);
  return {id:workout.id,programId:workout.program_id,programVersion:workout.program_version,rulesVersion:workout.rules_version,
    startedAt:workout.started_at,finishedAt:workout.finished_at,status:workout.status,stepProgress:steps.map(step=>step.progress),activeMs:workout.active_ms};
}

async function syncWorkout(db,userId,input,now,profile){
  keys(input,['workout','events']);keys(input.workout,['id','programId','startedAt']);
  const id=uuid(input.workout.id),startedAt=input.workout.startedAt;
  const catalogProgram=typeof input.workout.programId==='string'&&findWorkoutProgram(input.workout.programId);
  if(!catalogProgram)fail(400,'WORKOUT_PROGRAM_NOT_FOUND');
  if(!integer(startedAt)||startedAt>now+5000)fail(400,'INVALID_WORKOUT_TIME');
  if(!Array.isArray(input.events)||input.events.length>100)fail(400,'INVALID_EVENTS');
  const existing=await row(db,'SELECT * FROM workout_sessions WHERE id=?',id);
  if(existing&&existing.user_id!==userId)fail(404,'WORKOUT_NOT_FOUND','Тренировка не найдена.');
  if(existing&&(existing.program_id!==catalogProgram.id||existing.started_at!==startedAt))fail(409,'REQUEST_REUSED');
  if(!existing&&startedAt<now-EVENT_RETENTION_MS-DAY)fail(400,'INVALID_WORKOUT_TIME');
  const program=existing?JSON.parse(existing.program_json):catalogProgram,steps=expandWorkoutSteps(program);
  const settings=await row(db,'SELECT activated_at FROM activity_settings WHERE id=1');
  const unique=new Map(),parts=[];
  for(const value of input.events){
    keys(value,['id','stepIndex','occurredAt','durationMs']);
    const event={id:uuid(value.id),stepIndex:value.stepIndex,occurredAt:value.occurredAt};
    if(!integer(event.stepIndex)||event.stepIndex>=steps.length)fail(400,'INVALID_WORKOUT_STEP');
    const step=steps[event.stepIndex];
    if(step.unit==='ms'){
      if(!Number.isSafeInteger(value.durationMs)||value.durationMs<1||value.durationMs>1000)fail(400,'INVALID_WORKOUT_DURATION');
      event.durationMs=value.durationMs;
    }else if(value.durationMs!==undefined)fail(400,'INVALID_WORKOUT_DURATION');
    const end=event.occurredAt+(event.durationMs??0);
    if(!integer(event.occurredAt)||event.occurredAt<startedAt||end>startedAt+DAY||end>now+5000)fail(400,'INVALID_EVENT_TIME');
    const old=unique.get(event.id);if(old&&JSON.stringify(old)!==JSON.stringify(event))fail(409,'REQUEST_REUSED');
    unique.set(event.id,event);
  }
  const events=[...unique.values()];
  const savedEvents=events.length?await rows(db,'SELECT * FROM workout_events WHERE user_id=? AND id IN(SELECT value FROM json_each(?))',userId,JSON.stringify(events.map(event=>event.id))):[];
  const saved=new Map(savedEvents.map(event=>[event.id,event]));
  for(const event of events){
    const old=saved.get(event.id);
    if(old&&(old.workout_id!==id||old.step_index!==event.stepIndex||old.occurred_at!==event.occurredAt||old.duration_ms!==(event.durationMs??null)))fail(409,'REQUEST_REUSED');
    if(!old&&!validTime(event.occurredAt,now))fail(400,'INVALID_EVENT_TIME');
    for(const part of activityParts(event,steps[event.stepIndex].exercise,profile.time_zone,settings.activated_at))parts.push({id:event.id,...part});
  }
  const data=JSON.stringify(events),eventIds=JSON.stringify(events.map(event=>event.id));
  const results=await db.batch([
    db.prepare(`INSERT INTO workout_sessions(id,user_id,program_id,program_version,rules_version,program_json,started_at,received_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,userId,program.id,program.version,WORKOUT_RULES_VERSION,JSON.stringify(program),startedAt,now),
    db.prepare(`INSERT INTO workout_steps(workout_id,step_index,exercise,target)
      SELECT ?,CAST(key AS INTEGER),json_extract(value,'$.exercise'),json_extract(value,'$.target') FROM json_each(?)
      WHERE 1 ON CONFLICT(workout_id,step_index) DO NOTHING`).bind(id,JSON.stringify(steps)),
    db.prepare(`INSERT INTO workout_events(user_id,id,workout_id,step_index,occurred_at,duration_ms)
      SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.stepIndex'),json_extract(value,'$.occurredAt'),json_extract(value,'$.durationMs')
      FROM json_each(?) WHERE 1 ORDER BY json_extract(value,'$.stepIndex'),json_extract(value,'$.occurredAt'),json_extract(value,'$.id')
      ON CONFLICT(user_id,id) DO NOTHING RETURNING id`).bind(userId,id,data),
    db.prepare(`INSERT INTO activity_events(user_id,id,exercise,occurred_at,duration_ms,received_at)
      SELECT e.user_id,e.id,s.exercise,e.occurred_at,e.duration_ms,? FROM workout_events e
      JOIN workout_steps s ON s.workout_id=e.workout_id AND s.step_index=e.step_index
      WHERE e.user_id=? AND e.workout_id=? AND e.id IN(SELECT value FROM json_each(?))
      ON CONFLICT(user_id,id) DO NOTHING`).bind(now,userId,id,eventIds),
    db.prepare(`INSERT INTO activity_event_parts(user_id,event_id,local_date,squats,pushups,plank_ms,xp_squats,xp_pushups,xp_plank_ms)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.date'),json_extract(value,'$.squats'),json_extract(value,'$.pushups'),
        json_extract(value,'$.plankMs'),json_extract(value,'$.xpSquats'),json_extract(value,'$.xpPushups'),json_extract(value,'$.xpPlankMs')
      FROM json_each(?) WHERE 1 ON CONFLICT(user_id,event_id,local_date) DO NOTHING`).bind(userId,JSON.stringify(parts)),
    db.prepare(`INSERT INTO repetition_events(user_id,id,occurred_at,local_date,round_id,elapsed_ms,round_eligible,received_at)
      SELECT e.user_id,e.id,e.occurred_at,p.local_date,NULL,NULL,0,? FROM workout_events e
      JOIN workout_steps s ON s.workout_id=e.workout_id AND s.step_index=e.step_index
      JOIN activity_event_parts p ON p.user_id=e.user_id AND p.event_id=e.id
      WHERE e.user_id=? AND e.workout_id=? AND s.exercise='squat' AND e.id IN(SELECT value FROM json_each(?))
        AND NOT EXISTS(SELECT 1 FROM repetition_events r WHERE r.user_id=e.user_id AND r.id=e.id COLLATE NOCASE)
      ON CONFLICT(user_id,id) DO NOTHING`).bind(now,userId,id,eventIds),
  ]);
  const accepted=results[2].results.length;
  return {accepted,duplicate:input.events.length-accepted,workout:await view(db,await ownedWorkout(db,userId,id)),progress:await readActivity(db,userId,now)};
}

async function endWorkout(db,userId,id,action,input,now){
  keys(input,['endedAt','activeMs']);
  const workout=await ownedWorkout(db,userId,id),{endedAt,activeMs}=input;
  if(!integer(endedAt)||endedAt<workout.started_at||endedAt>workout.started_at+DAY||endedAt>now+5000||!integer(activeMs)||activeMs>endedAt-workout.started_at)fail(400,'INVALID_WORKOUT_TIME');
  if(workout.status==='active'){
    if(!validTime(endedAt,now))fail(400,'INVALID_WORKOUT_TIME');
    const last=await row(db,'SELECT MAX(occurred_at+COALESCE(duration_ms,0)) AS ended FROM workout_events WHERE workout_id=?',id);
    if(last.ended!==null&&endedAt<last.ended)fail(400,'INVALID_WORKOUT_TIME');
    const incomplete=await row(db,'SELECT 1 FROM workout_steps WHERE workout_id=? AND progress<target LIMIT 1',id);
    if(action==='finish'&&incomplete)fail(409,'WORKOUT_INCOMPLETE','Не все упражнения выполнены. Можно сохранить частичный результат.');
    await db.prepare(`UPDATE workout_sessions SET status=?,finished_at=?,active_ms=? WHERE id=? AND user_id=? AND status='active'
      AND (?='aborted' OR NOT EXISTS(SELECT 1 FROM workout_steps WHERE workout_id=? AND progress<target))
      AND NOT EXISTS(SELECT 1 FROM workout_events WHERE workout_id=? AND occurred_at+COALESCE(duration_ms,0)>?)`)
      .bind(action==='finish'?'completed':'aborted',endedAt,activeMs,id,userId,action==='finish'?'completed':'aborted',id,id,endedAt).run();
  }
  const saved=await ownedWorkout(db,userId,id);
  if(saved.status==='active')fail(400,'INVALID_WORKOUT_TIME');
  if(action==='finish'&&saved.status==='aborted')fail(409,'WORKOUT_CLOSED','Тренировка сохранена частично.');
  return {workout:await view(db,saved),progress:await readActivity(db,userId,now)};
}
function decodeCursor(value){
  if(!value)return null;
  if(value.length>512||!/^[a-zA-Z0-9_-]+$/.test(value))fail(400,'INVALID_CURSOR');
  try{const cursor=JSON.parse(atob(value.replaceAll('-','+').replaceAll('_','/')));
    if(cursor.kind!=='workouts'||!Array.isArray(cursor.key)||cursor.key.length!==2||!integer(cursor.key[0])||typeof cursor.key[1]!=='string'||!UUID.test(cursor.key[1]))fail(400,'INVALID_CURSOR');return cursor.key;
  }catch{fail(400,'INVALID_CURSOR');}
}
async function history(db,userId,params,now){
  const raw=params.get('limit')??'20';if(!/^\d{1,3}$/.test(raw)||Number(raw)<1||Number(raw)>100)fail(400,'INVALID_LIMIT');
  const limit=Number(raw),key=decodeCursor(params.get('cursor'));
  let workouts=await rows(db,"SELECT * FROM workout_sessions WHERE user_id=? AND status!='active'"+(key?' AND (started_at<? OR (started_at=? AND id<?))':'')+' ORDER BY started_at DESC,id DESC LIMIT ?',userId,...(key?[key[0],key[0],key[1]]:[]),limit+1);
  const more=workouts.length>limit;workouts=workouts.slice(0,limit);
  const last=workouts.at(-1),nextCursor=more?btoa(JSON.stringify({kind:'workouts',key:[last.started_at,last.id]})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null;
  const allSteps=workouts.length?await rows(db,'SELECT workout_id,progress FROM workout_steps WHERE workout_id IN(SELECT value FROM json_each(?)) ORDER BY workout_id,step_index',JSON.stringify(workouts.map(workout=>workout.id))):[];
  return {items:await Promise.all(workouts.map(workout=>view(db,workout,allSteps.filter(step=>step.workout_id===workout.id)))),nextCursor,limit,serverNow:now};
}
export function isWorkoutRoute(path){return path==='/api/activity'||path.startsWith('/api/workouts/');}
export async function handleWorkoutRequest(db,userId,path,method,input,params,now){
  const profile=await profileFor(db,userId);
  if(method==='GET'&&path==='/api/activity')return readActivity(db,userId,now);
  if(method==='GET'&&path==='/api/workouts/catalog')return {programs:WORKOUT_PROGRAMS,rulesVersion:WORKOUT_RULES_VERSION,serverNow:now};
  if(method==='GET'&&path==='/api/workouts/history')return history(db,userId,params,now);
  if(method==='POST'&&path==='/api/workouts/sync')return syncWorkout(db,userId,input,now,profile);
  const end=path.match(/^\/api\/workouts\/([^/]+)\/(finish|abort)$/);
  if(method==='POST'&&end)return endWorkout(db,userId,uuid(end[1]),end[2],input,now);
  fail(404,'NOT_FOUND','Страница не найдена.');
}
