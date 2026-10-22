import {RULES_VERSION, ROUND_MS, DELIVERY_GRACE_MS, DAILY_GOAL, DAILY_POINTS, COMPETITION_MS, ATTEMPT_LIMIT, EVENT_RETENTION_MS} from './rules.js';
import {weeklyState,leaderboard,validWeek,acknowledgeWeek,summaryView} from './weeks.js';

import {ensureCurrentWeek,reconcileUser} from './maintenance.js';
import {readDashboard,readReceipt,readPage} from './reads.js';

const stateFor=(db,userId,now,compact)=>compact?readDashboard(db,userId,now):readState(db,userId,now);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'}});
export class ApiError extends Error {constructor(status, code, message) {super(message); this.status = status; this.code = code;}}
const reject = (status, code, message) => {throw new ApiError(status, code, message);};
const row = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const rows = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) reject(400, 'INVALID_INPUT', 'Проверьте данные запроса.');
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) reject(400, 'INVALID_ID', 'Не удалось определить запрос. Повторите действие.');
  return value;
}
function token(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) reject(400, 'INVALID_INVITATION', 'Ссылка приглашения неверна. Попросите друга отправить новую.');
  return value.toLowerCase();
}
async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
const dateFormatters=new Map();
export function localDate(timestamp, timeZone) {
  if(!dateFormatters.has(timeZone)){if(dateFormatters.size>=32)dateFormatters.delete(dateFormatters.keys().next().value);dateFormatters.set(timeZone,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}));}
  const parts=dateFormatters.get(timeZone).formatToParts(new Date(timestamp));
  const pick = type => parts.find(part => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function subtractDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() - count);
  return value.toISOString().slice(0, 10);
}
export function roundView(value) {
  return {id:value.id, kind:value.kind, status:value.status, competitionId:value.competition_id, rulesVersion:value.rules_version, startsAt:value.starts_at, endsAt:value.ends_at, finishedAt:value.finished_at, count:value.count};
}
export const profileView = value => value ? {id:value.user_id, displayName:value.display_name, timeZone:value.time_zone,rankingsEnabled:!value.rankings_excluded} : null;

// Stale attempts become interrupted, never a fabricated completed result.
async function expire(db, now, userId) {
  await db.prepare("UPDATE rounds SET status='aborted', finished_at=ends_at WHERE user_id=? AND status='active' AND ends_at < ?").bind(userId, now-DELIVERY_GRACE_MS).run();
}

export async function competitionView(db, value, userId, now, cached=null) {
  const members = [value.creator_id, value.opponent_id].filter(Boolean);
  const names = cached?.names ?? await rows(db, `SELECT user_id, display_name FROM profiles WHERE user_id IN (${members.map(() => '?').join(',')})`, ...members);
  const attempts = cached ? cached.attempts.filter(attempt => attempt.competition_id === value.id) : await rows(db, 'SELECT user_id, status, count, rules_version,ends_at FROM rounds WHERE competition_id=?', value.id);
  for(const attempt of attempts)if(attempt.status==='active'&&attempt.ends_at+DELIVERY_GRACE_MS<now)attempt.status='aborted';
  const participants = members.map((id, index) => {
    const mine = attempts.filter(attempt => attempt.user_id === id);
    // A duel keeps repetitions delivered before an early stop. The round stays
    // aborted, so personal history and the 60-second rankings still exclude it.
    // An empty interrupted attempt consumes a try without fabricating a score.
    const scored = mine.filter(attempt => attempt.rules_version === value.rules_version &&
      (attempt.status === 'completed' || attempt.status === 'aborted' && attempt.count > 0));
    return {role:index ? 'opponent' : 'creator', name:names.find(profile => profile.user_id === id)?.display_name ?? 'Участник', isYou:id === userId,
      best:scored.length ? Math.max(...scored.map(attempt => attempt.count)) : null, attemptsUsed:mine.length, attemptsLeft:Math.max(0, ATTEMPT_LIMIT-mine.length), activeAttempt:mine.some(attempt => attempt.status === 'active')};
  });
  const active = participants.some(participant => participant.activeAttempt);
  const exhausted = participants.length === 2 && participants.every(participant => participant.attemptsLeft === 0) && !active;
  const expired = value.expires_at !== null && now >= value.expires_at;
  const status = value.cancelled_at!==null ? 'cancelled' : !value.opponent_id ? 'invited' : expired && active ? 'settling' : expired || exhausted ? 'finished' : 'active';
  let result = null;
  if (status === 'finished') {
    if (participants.some(participant => participant.best === null)) result = {type:'not_held', winner:null};
    else if (participants[0].best === participants[1].best) result = {type:'tie', winner:null};
    else result = {type:'winner', winner:participants[0].best > participants[1].best ? 'creator' : 'opponent'};
  }
  const me = participants.find(participant => participant.isYou);
  const runningElsewhere = cached ? cached.active : await row(db, "SELECT id FROM rounds WHERE user_id=? AND status='active'", userId);
  return {id:value.id, rulesVersion:value.rules_version, status, createdAt:value.created_at, acceptedAt:value.accepted_at, expiresAt:value.expires_at, participants, result,
    canCancel:status==='invited'&&value.creator_id===userId,
    canStart:status === 'active' && value.rules_version === RULES_VERSION && !!me && me.attemptsLeft > 0 && !runningElsewhere && value.expires_at-now >= ROUND_MS,
    preliminary:status === 'active' || status === 'settling'};
}

export async function readState(db, userId, now) {
  await reconcileUser(db,userId,now);

  const profile = await row(db, 'SELECT * FROM profiles WHERE user_id=?', userId);
  if (!profile) return {profile:null,today:null,days:[],points:0,last7:0,rounds:[],activeRound:null,competitions:[],serverNow:now,rulesVersion:RULES_VERSION};
  const date = localDate(now, profile.time_zone);
  // Read the dashboard from one transactional snapshot. In particular, daily
  // progress and its reward cannot appear to disagree during a second-tab write.
  const snapshot = await db.batch([
    db.prepare('SELECT local_date AS date, count FROM daily_progress WHERE user_id=? ORDER BY local_date DESC').bind(userId),
    db.prepare('SELECT (SELECT COALESCE(SUM(points),0) FROM daily_rewards WHERE user_id=?)+(SELECT COALESCE(SUM(points),0) FROM weekly_bonuses WHERE user_id=?) AS points').bind(userId,userId),
    db.prepare("SELECT * FROM rounds WHERE user_id=? AND status='completed' ORDER BY finished_at DESC, id DESC").bind(userId),
    db.prepare("SELECT * FROM rounds WHERE user_id=? AND status='active'").bind(userId),
    db.prepare('SELECT * FROM competitions WHERE creator_id=? OR opponent_id=? ORDER BY created_at DESC, id DESC').bind(userId,userId),
    db.prepare('SELECT user_id,display_name FROM profiles WHERE user_id IN (SELECT creator_id FROM competitions WHERE creator_id=? OR opponent_id=? UNION SELECT opponent_id FROM competitions WHERE creator_id=? OR opponent_id=?)').bind(userId,userId,userId,userId),
    db.prepare('SELECT competition_id,user_id,status,count,rules_version,ends_at FROM rounds WHERE competition_id IN (SELECT id FROM competitions WHERE creator_id=? OR opponent_id=?)').bind(userId,userId),
  ]);
  const [progress, rewards, history, activeRows, competitions, names, attempts] = snapshot.map(result=>result.results);
  const earned=rewards[0], active=activeRows[0] ?? null;
  const days = progress.map(day => ({...day,completed:day.count >= DAILY_GOAL}));
  const count = days.find(day => day.date === date)?.count ?? 0;
  return {profile:profileView(profile),today:{date,count,goal:DAILY_GOAL,completed:count >= DAILY_GOAL},days,points:earned.points,
    last7:days.filter(day => day.completed && day.date >= subtractDays(date,6) && day.date <= date).length,
    rounds:history.map(roundView),activeRound:active ? roundView(active) : null,
    competitions:await Promise.all(competitions.map(value => competitionView(db,value,userId,now,{names,attempts,active}))),
    weekly:await weeklyState(db,userId,profile,now),serverNow:now,rulesVersion:RULES_VERSION};
}

async function requireProfile(db, userId) {
  const profile = await row(db, 'SELECT * FROM profiles WHERE user_id=?', userId);
  if (!profile) reject(409, 'PROFILE_REQUIRED', 'Сначала сохраните профиль.');
  return profile;
}
async function requireRound(db, userId, id) {
  uuid(id);
  const value = await row(db, 'SELECT * FROM rounds WHERE id=? AND user_id=?', id, userId);
  if (!value) reject(404, 'ROUND_NOT_FOUND', 'Попытка не найдена.');
  return value;
}

async function profileRoute(db, userId, input, now,compact=false) {
  keys(input, ['displayName','timeZone','rankingsEnabled']);
  if(input.rankingsEnabled!==undefined&&typeof input.rankingsEnabled!=='boolean')reject(400,'INVALID_INPUT','Проверьте настройку участия.');
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName || [...displayName].length > 40 || /[\u0000-\u001f\u007f]/.test(displayName)) reject(400,'INVALID_NAME','Имя должно содержать от 1 до 40 символов.');
  if (typeof input.timeZone !== 'string' || input.timeZone.length > 80) reject(400,'INVALID_TIME_ZONE','Не удалось определить часовой пояс.');
  try {new Intl.DateTimeFormat('en', {timeZone:input.timeZone}).format();} catch {reject(400,'INVALID_TIME_ZONE','Не удалось определить часовой пояс.');}
  // A second device may submit its own timezone; the original profile timezone
  // intentionally remains authoritative for calendar-day boundaries.
  // Keep a consent timeline so delayed cron closure observes the delivery
  // cutoff even when this edit happens before that cron invocation.

  // A separate exclusion flag makes both existing and new profiles participate
  // by default, without rebuilding profiles or changing historical awards.
  // Once explicitly excluded in this version, ordinary profile edits preserve it.
  await db.batch([db.prepare(`INSERT INTO profiles(user_id,display_name,time_zone,created_at,rankings_excluded) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,rankings_excluded=CASE WHEN ? IS NULL THEN profiles.rankings_excluded ELSE excluded.rankings_excluded END`).bind(userId,displayName,input.timeZone,now,input.rankingsEnabled===false?1:0,input.rankingsEnabled===undefined?null:1),db.prepare(`INSERT INTO ranking_consent(user_id,changed_at,excluded) SELECT user_id,?,rankings_excluded FROM profiles WHERE user_id=? ON CONFLICT(user_id,changed_at) DO UPDATE SET excluded=excluded.excluded`).bind(now,userId)]);
  return {profile:profileView(await requireProfile(db,userId)),state:await stateFor(db,userId,now,compact)};
}

async function repetitionsRoute(db, userId, input, now,compact=false) {
  keys(input,['events']);
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) reject(400,'INVALID_EVENTS','Отправляйте от 1 до 100 повторений за раз.');
  const profile = await requireProfile(db,userId), inserts = [];
  const ids=[...new Set(input.events.map(event=>event?.roundId).filter(id=>id!==null&&id!==undefined))];
  for(const id of ids)uuid(id);
  const roundRows=ids.length?await rows(db,'SELECT * FROM rounds WHERE user_id=? AND id IN(SELECT value FROM json_each(?))',userId,JSON.stringify(ids)):[];
  const rounds=new Map(roundRows.map(r=>[r.id,r]));
  for (const event of input.events) {
    keys(event,['id','occurredAt','roundId','elapsedMs']); uuid(event.id);
    const occurredAt = typeof event.occurredAt === 'number' ? event.occurredAt : typeof event.occurredAt === 'string' ? Date.parse(event.occurredAt) : NaN;
    if (!Number.isSafeInteger(occurredAt) || occurredAt > now+5_000 || occurredAt < now-EVENT_RETENTION_MS) reject(400,'INVALID_EVENT_TIME','Время повторения недоступно для сохранения. Обновите данные и повторите.');
    let roundId = null, elapsed = null, eligible = 0;
    if (event.roundId !== undefined && event.roundId !== null) {
      const value=rounds.get(event.roundId);if(!value)reject(404,'ROUND_NOT_FOUND','Попытка не найдена.');
      roundId = value.id; elapsed = event.elapsedMs;
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed >= ROUND_MS) reject(400,'INVALID_ROUND_TIME','Повторение находится за пределами минутного раунда.');
      const actual = value.starts_at+elapsed;
      if (Math.abs(actual-occurredAt) > 5_000 || actual > now+5_000) reject(400,'INVALID_ROUND_TIME','Время повторения не совпадает с началом раунда.');
      if (value.status === 'aborted' && actual > value.finished_at) reject(400,'ROUND_INTERRUPTED','Повторение произошло после остановки раунда.');
      eligible = value.status === 'active' && now <= value.ends_at+DELIVERY_GRACE_MS && value.rules_version === RULES_VERSION ? 1 : 0;
    } else if (event.elapsedMs !== undefined && event.elapsedMs !== null) reject(400,'INVALID_ROUND_TIME','Для минутного повторения нужна попытка.');
    inserts.push({id:event.id,occurredAt,localDate:localDate(occurredAt,profile.time_zone),roundId,elapsed,eligible});
  }
  // D1 batch is a transaction: event uniqueness, progress, reward and round
  // count changes performed by its trigger commit together or roll back.
  const saved = await db.batch([db.prepare(`INSERT INTO repetition_events(user_id,id,occurred_at,local_date,round_id,elapsed_ms,round_eligible,received_at)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.occurredAt'),json_extract(value,'$.localDate'),json_extract(value,'$.roundId'),json_extract(value,'$.elapsed'),json_extract(value,'$.eligible'),?
    FROM json_each(?) WHERE 1 ON CONFLICT(user_id,id) DO NOTHING RETURNING id`).bind(userId,now,JSON.stringify(inserts))]);
  const accepted = saved.reduce((sum,result) => sum+(result.results?.length ?? 0),0);
  return {accepted,duplicate:input.events.length-accepted,state:await (compact?readReceipt(db,userId,now):readState(db,userId,now))};
}

async function startRoute(db,userId,input,now,clock=()=>now) {
  keys(input,['requestId','kind','competitionId']); uuid(input.requestId); await requireProfile(db,userId);

  if (!['personal','competition'].includes(input.kind) || input.kind === 'personal' && input.competitionId != null) reject(400,'INVALID_MODE','Выберите режим минутного раунда.');
  const existing = await row(db,'SELECT * FROM rounds WHERE user_id=? AND start_request_id=?',userId,input.requestId);
  if (existing) {
    if (existing.kind !== input.kind || existing.competition_id !== (input.competitionId ?? null)) reject(409,'REQUEST_REUSED','Этот запрос уже использован для другой попытки.');
    return {round:roundView(existing),serverNow:now};
  }
  // Do not consume the minute while profile/idempotency reads are pending.
  // The same fresh instant governs both the deadline check and the insertion.
  now=clock();
  const id=crypto.randomUUID(), competitionId=input.kind === 'competition' ? uuid(input.competitionId) : null;
  const inserted=await db.prepare(`INSERT INTO rounds(id,user_id,start_request_id,kind,competition_id,rules_version,starts_at,ends_at)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rounds WHERE user_id=? AND status='active')
    AND (? IS NULL OR EXISTS(SELECT 1 FROM competitions c WHERE c.id=? AND (c.creator_id=? OR c.opponent_id=?) AND c.opponent_id IS NOT NULL AND c.cancelled_at IS NULL AND c.rules_version=? AND c.expires_at>=?
      AND (SELECT COUNT(*) FROM rounds r WHERE r.competition_id=c.id AND r.user_id=?)<?))
    ON CONFLICT(user_id,start_request_id) DO NOTHING RETURNING *`).bind(id,userId,input.requestId,input.kind,competitionId,RULES_VERSION,now,now+ROUND_MS,userId,competitionId,competitionId,userId,userId,RULES_VERSION,now+ROUND_MS,userId,ATTEMPT_LIMIT).all();
  const value=inserted.results[0] ?? await row(db,'SELECT * FROM rounds WHERE user_id=? AND start_request_id=?',userId,input.requestId);
  if (value) return {round:roundView(value),serverNow:now};
  if (await row(db,"SELECT id FROM rounds WHERE user_id=? AND status='active'",userId)) reject(409,'ACTIVE_ROUND','У вас уже идёт минутный раунд. Завершите его на другом устройстве или вкладке.');
  if (competitionId) {
    const competition=await row(db,'SELECT * FROM competitions WHERE id=? AND (creator_id=? OR opponent_id=?)',competitionId,userId,userId);
    if (!competition) reject(404,'COMPETITION_NOT_FOUND','Соревнование не найдено.');
    if (competition.cancelled_at!==null) reject(409,'INVITATION_CANCELLED','Автор отменил приглашение.');
    if (!competition.opponent_id) reject(409,'INVITATION_PENDING','Сначала друг должен принять приглашение.');
    if (competition.rules_version !== RULES_VERSION) reject(409,'INCOMPATIBLE_RULES','Версия правил этого соревнования несовместима.');
    if (competition.expires_at-now < ROUND_MS) reject(409,'COMPETITION_CLOSING','До окончания осталось меньше 60 секунд. Новую попытку начать нельзя.');
    reject(409,'ATTEMPTS_EXHAUSTED','Все три попытки уже использованы.');
  }
  reject(409,'START_CONFLICT','Не удалось начать раунд. Обновите данные и повторите.');
}

async function endRoute(db,userId,id,action,input,now,compact=false) {
  keys(input,['requestId']); if (input.requestId !== undefined) uuid(input.requestId);
  const value=await requireRound(db,userId,id);
  if (value.status === 'active') {
    if (action === 'finish') {
      if (now < value.ends_at) reject(409,'ROUND_RUNNING','Минутный раунд ещё идёт.');
      if (now > value.ends_at+DELIVERY_GRACE_MS) reject(409,'ROUND_INTERRUPTED','Результат не подтверждён вовремя. Попытка прервана.');
      await db.prepare("UPDATE rounds SET status='completed',finished_at=? WHERE id=? AND user_id=? AND status='active' AND ends_at<=? AND ends_at+?>=?").bind(value.ends_at,id,userId,now,DELIVERY_GRACE_MS,now).run();
    } else await db.prepare("UPDATE rounds SET status='aborted',finished_at=? WHERE id=? AND user_id=? AND status='active'").bind(Math.min(now,value.ends_at),id,userId).run();
  }
  const saved=await requireRound(db,userId,id);
  if (action === 'finish' && saved.status === 'aborted') reject(409,'ROUND_INTERRUPTED','Попытка прервана и не участвует в рекордах.');
  return {round:roundView(saved),state:await stateFor(db,userId,now,compact)};
}

async function createCompetition(db,userId,input,now) {
  keys(input,['requestId','token']); uuid(input.requestId); const invitationToken=token(input.token); await requireProfile(db,userId);

  const digest=await hash(invitationToken);
  await db.prepare('INSERT INTO competitions(id,creator_id,token_hash,create_request_id,rules_version,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(creator_id,create_request_id) DO NOTHING').bind(crypto.randomUUID(),userId,digest,input.requestId,RULES_VERSION,now).run();
  const value=await row(db,'SELECT * FROM competitions WHERE creator_id=? AND create_request_id=?',userId,input.requestId);
  if (value.token_hash !== digest) reject(409,'REQUEST_REUSED','Повторите создание приглашения с теми же данными.');
  return {competition:await competitionView(db,value,userId,now),invitationToken};
}

async function invitationRoute(db,userId,input,action,now,compact=false) {
  keys(input,['token']); const digest=await hash(token(input.token));

  const value=await row(db,'SELECT * FROM competitions WHERE token_hash=?',digest);
  if (!value) reject(404,'INVITATION_NOT_FOUND','Приглашение не найдено. Попросите друга отправить новую ссылку.');
  if (action === 'preview') {
    const creator=await row(db,'SELECT display_name FROM profiles WHERE user_id=?',value.creator_id);
    return {competitionId:value.id,creatorName:creator.display_name,status:value.cancelled_at!==null?'cancelled':value.opponent_id ? 'unavailable' : 'invited',rulesVersion:value.rules_version,
      canAccept:value.cancelled_at===null&&!value.opponent_id && value.creator_id !== userId && value.rules_version === RULES_VERSION};
  }
  await requireProfile(db,userId);
  if(value.cancelled_at!==null)reject(409,'INVITATION_CANCELLED','Автор отменил приглашение. Попросите новую ссылку.');
  if (value.creator_id === userId) reject(409,'SELF_INVITATION','Автор не может принять собственное приглашение.');
  if (value.rules_version !== RULES_VERSION) reject(409,'INCOMPATIBLE_RULES','Версия правил приглашения несовместима.');
  await db.prepare('UPDATE competitions SET opponent_id=?,accepted_at=?,expires_at=? WHERE id=? AND opponent_id IS NULL AND cancelled_at IS NULL AND creator_id!=?').bind(userId,now,now+COMPETITION_MS,value.id,userId).run();
  const saved=await row(db,'SELECT * FROM competitions WHERE id=?',value.id);
  if(saved.cancelled_at!==null)reject(409,'INVITATION_CANCELLED','Автор отменил приглашение. Попросите новую ссылку.');
  if (saved.opponent_id !== userId) reject(409,'INVITATION_TAKEN','Это приглашение уже принято другим участником.');
  return {competition:await competitionView(db,saved,userId,now),state:await stateFor(db,userId,now,compact)};
}

async function cancelCompetition(db,userId,id,input,now,compact=false) {
  keys(input,[]);uuid(id);await requireProfile(db,userId);
  const value=await row(db,'SELECT * FROM competitions WHERE id=? AND creator_id=?',id,userId);
  if(!value)reject(404,'COMPETITION_NOT_FOUND','Соревнование не найдено.');
  // Accept and cancel compete on the same row/condition. Exactly one can win;
  // neither a retry nor a stale browser can cancel an already accepted duel.
  await db.prepare('UPDATE competitions SET cancelled_at=? WHERE id=? AND creator_id=? AND opponent_id IS NULL AND cancelled_at IS NULL').bind(now,id,userId).run();
  const saved=await row(db,'SELECT * FROM competitions WHERE id=?',id);
  if(saved.cancelled_at===null)reject(409,'INVITATION_ACCEPTED','Друг уже принял вызов. Принятую дуэль отменить нельзя.');
  return {competition:await competitionView(db,saved,userId,now),state:await stateFor(db,userId,now,compact)};
}

export async function handleApi(request, env, options={}) {
  try {
    const url=new URL(request.url);
    const userId=request.headers.get('oai-authenticated-user-id')||request.headers.get('x-test-user-id');
    if (!userId || userId.length > 200) reject(401,'SIGN_IN_REQUIRED','Войдите в профиль, чтобы сохранить результаты.');
    if (!env.DB) reject(503,'STORAGE_UNAVAILABLE','Серверное хранение ещё не подключено. Результаты пока не сохраняются.');
    if (request.method !== 'GET' && request.method !== 'POST') reject(405,'METHOD_NOT_ALLOWED','Этот способ запроса недоступен.');
    if (request.method === 'POST' && request.headers.get('origin') !== url.origin) reject(403,'ORIGIN_FORBIDDEN','Откройте приложение напрямую и повторите действие.');
    const clock=typeof options.now === 'function' ? options.now : Date.now;
    const now=clock();
    if (!Number.isSafeInteger(now)) throw new Error('Invalid server clock');
    await ensureCurrentWeek(env.DB,now);
    await expire(env.DB,now,userId);
    const compact=url.pathname.startsWith('/api/v2/');
    if(compact)url.pathname=url.pathname.replace('/api/v2/','/api/');
    if(compact&&request.method==='GET'&&url.pathname==='/api/dashboard')return json(await readDashboard(env.DB,userId,now));
    const page=compact&&request.method==='GET'&&url.pathname.match(/^\/api\/(?:history\/(rounds|progress|weeks)|(competitions))$/);
    if(page)return json(await readPage(env.DB,userId,page[1]||page[2],url.searchParams,now));
    if (request.method === 'GET' && url.pathname === '/api/state') return json(await readState(env.DB,userId,now));
    if (request.method === 'GET' && url.pathname === '/api/leaderboards') {
      const type=url.searchParams.get('type')??'result',period=url.searchParams.get('period')??'week',week=url.searchParams.get('week')??undefined;
      if(!['result','points'].includes(type)||!['week','all'].includes(period)||type==='result'&&period!=='week'||week!==undefined&&!validWeek(week))reject(400,'INVALID_INPUT','Выберите период рейтинга.');
      await requireProfile(env.DB,userId);
      const value=await leaderboard(env.DB,userId,{type,period,week},now);
      if(!value)reject(404,'NOT_FOUND','Этот период пока недоступен.');
      return json(value);
    }
    if (request.method !== 'POST') reject(404,'NOT_FOUND','Страница не найдена.');
    if (!request.headers.get('content-type')?.startsWith('application/json')) reject(415,'JSON_REQUIRED','Не удалось прочитать данные запроса.');
    const body=await request.text();
    if (body.length > 65_536) reject(413,'TOO_LARGE','Слишком много данных. Повторите отправку небольшими частями.');
    let input; try {input=JSON.parse(body);} catch {reject(400,'INVALID_JSON','Не удалось прочитать данные запроса.');}
    if (url.pathname === '/api/profile') return json(await profileRoute(env.DB,userId,input,now,compact));
    if(url.pathname === '/api/weeks/seen') {
      keys(input,['week','total']);
      if(!validWeek(input.week)||!Number.isSafeInteger(input.total)||input.total<0)reject(400,'INVALID_INPUT','Не удалось отметить итоги.');
      await requireProfile(env.DB,userId);
      await acknowledgeWeek(env.DB,userId,input.week,input.total,now);
      const state=await stateFor(env.DB,userId,now,compact);
      if(compact&&state.weekly&&!state.weekly.summaries.some(s=>s.week===input.week)){
        const summary=await row(env.DB,'SELECT s.*,w.ends_at,w.rules_version FROM weekly_summaries s JOIN weekly_periods w ON w.week=s.week WHERE s.user_id=? AND s.week=?',userId,input.week);
        if(summary)state.weekly.summaries.push(summaryView(summary,now));
      }
      return json({state});
    }
    if (url.pathname === '/api/repetitions') return json(await repetitionsRoute(env.DB,userId,input,now,compact));
    if (url.pathname === '/api/rounds/start') {
      const result=await startRoute(env.DB,userId,input,now,clock),sentAt=clock();
      return json({...result,serverNow:sentAt,processingMs:Math.max(0,sentAt-now)});
    }
    const end=url.pathname.match(/^\/api\/rounds\/([^/]+)\/(finish|abort)$/);
    if (end) return json(await endRoute(env.DB,userId,end[1],end[2],input,now,compact));
    if (url.pathname === '/api/competitions') return json(await createCompetition(env.DB,userId,input,now));
    const cancellation=url.pathname.match(/^\/api\/competitions\/([^/]+)\/cancel$/);
    if(cancellation)return json(await cancelCompetition(env.DB,userId,cancellation[1],input,now,compact));
    const invitation=url.pathname.match(/^\/api\/invitations\/(preview|accept)$/);
    if (invitation) return json(await invitationRoute(env.DB,userId,input,invitation[1],now,compact));
    reject(404,'NOT_FOUND','Страница не найдена.');
  } catch (error) {
    if (error instanceof ApiError) return json({error:{code:error.code,message:error.message}},error.status);
    console.error('API request failed:', error.name);
    return json({error:{code:'SERVER_ERROR',message:'Не удалось сохранить данные. Повторите отправку; повторения не продублируются.'}},500);
  }
}
