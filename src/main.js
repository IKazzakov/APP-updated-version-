import './style.css';
import {Training} from './training.js';
import {api,ApiError,getTestUser,signInGuest,signOutDevice,getConnectionDiagnostic} from './api.js';
import {Outbox} from './outbox.js';
import {Diagnostics} from './diagnostics.js';
import {comparableRounds} from './progress.js';
import {copyReport,selectReport} from './clipboard.js';
import {RULES_VERSION,VERSION} from './config.js';
import {CameraLease} from './camera-lease.js';
import {RoundPreparation} from './round-preparation.js';
import {RoundSound} from './sound.js';
import {serverTimeAtReceipt} from './round-clock.js';
import {WeeklyUI} from './weekly.js';
import {ScreenWakeLock} from './wake-lock.js';
import {isNativeApp, invitationOrigin, getApiBaseUrl, setNativeApiUrl, profileStorageId} from './platform.js';

const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(id,value)=>{if($(id).textContent!==String(value))$(id).textContent=String(value);};
const dateLabel=(value,options={day:'numeric',month:'short'})=>new Intl.DateTimeFormat('ru-RU',{...options,timeZone:state?.profile?.timeZone||'UTC'}).format(new Date(value));
let state=null,outbox=null,outboxReady=false,tab='today',mode='practice',competitionId=null,busy=false,roundSaving=false,calendarOffset=0,refreshTimer=null,activeInvitation=null,pendingStart=null;
let sync={pending:0,saving:false,error:null},persistenceError=false,lastTraining=null;
let loading=false,loadError=null,localPracticeSession=false;
let authBusy=false,outboxOwner=null;
let visualSignal=null;
const pendingWrites=new Set();
const diagnostics=new Diagnostics();
const cameraLease=new CameraLease({native:isNativeApp()});
const wakeLock=new ScreenWakeLock();
const sound=new RoundSound({onChange:message=>{text('sound-status',message);if(lastTraining)renderTraining(engine.state);}});
const preparation=new RoundPreparation({onChange:s=>{if(['idle','waiting','error'].includes(s.status))sound.stop();if(['idle','error'].includes(s.status))wakeLock.release();if(lastTraining)renderTraining(engine.state);},onSignal:announceSignal,onStart:launchRound});
const inviteMatch=location.hash.match(/^#invite=([a-f0-9]{64})$/);
let receivedInvite=inviteMatch?.[1]||null;
if(receivedInvite){sessionStorage.setItem('movement.receivedInvite',receivedInvite);history.replaceState(null,'',location.pathname+location.search);}
else receivedInvite=sessionStorage.getItem('movement.receivedInvite');
const engine=new Training($('video'),$('overlay'),{onChange:s=>{if(!s.cameraOn&&!s.starting&&preparation.pending)preparation.cancel();if(!s.cameraOn&&!s.starting)wakeLock.release();preparation.observe(s);renderTraining(s);},onRepetition:event=>{const write=saveRepetition(event);pendingWrites.add(write);write.finally(()=>pendingWrites.delete(write));},onError:error=>{wakeLock.release();diagnostics.error(error.name==='NotAllowedError'?'CAMERA_DENIED':'CAMERA_OR_MODEL');showError(lastTraining?.reason||'Не удалось запустить камеру. Повторите попытку.');},onRoundEnd:result=>{wakeLock.release();saveRound(result);}});
const weekly=new WeeklyUI({api,onState:applyState,onError:error=>showError(errorMessage(error)),onPersonal:()=>chooseMode('personal'),onProfile:()=>openProfile(true),onCompetitions:()=>setTab('competitions')});
function openProfile(pushState=true){
  $('profile-panel').hidden=false;$('profile-toggle').setAttribute('aria-expanded','true');
  $('rankings-excluded').checked=!state?.profile?.rankingsEnabled;
  $('profile-panel').scrollIntoView({block:'start',behavior:'smooth'});
  if(pushState){try{history.pushState({panel:'profile'},'');}catch{}}
}
function closeProfile(popHistory=false){
  $('profile-panel').hidden=true;$('profile-toggle').setAttribute('aria-expanded','false');
  if(popHistory&&history.state?.panel==='profile'){history.back();}
}
function showError(message){$('app-error').hidden=!message;text('app-error',message||'');}
function errorMessage(error){return error instanceof ApiError?error.userMessage:'Не удалось выполнить действие. Проверьте соединение и повторите попытку.';}
function setConnection(){
  const el=$('connection');el.classList.toggle('warning',!navigator.onLine||!!sync.error||persistenceError||!!loadError);
  $('retry-sync').hidden=!sync.error&&!loadError;
  $('retry-sync').disabled=loading;
  text('retry-sync',outbox?'Повторить сохранение':'Повторить подключение');
  const report=getConnectionDiagnostic();
  text('server-result',loading?'Проверяем соединение…':`${report.status ? `HTTP ${report.status} · ` : ''}${report.code}`);
  $('check-server').disabled=loading;
  if(loading){el.textContent='Подключаемся к серверу…';return;}
  if(!state?.profile){el.textContent=loading?'Подключаемся к серверу…':'Профиль не загружен. Камеру и подсчёт можно проверить в обычной тренировке.';return;}
  if(loadError){el.textContent=errorMessage(loadError);return;}
  if(persistenceError){el.textContent='Не удалось записать повторение на устройстве. Сделайте паузу и освободите память.';return;}
  if(!navigator.onLine){el.textContent=`Нет сети. ${sync.pending?`Ожидают сохранения: ${sync.pending}. `:''}Подключитесь, чтобы подтвердить прогресс.`;return;}
  if(sync.error){el.textContent=`${sync.error} Ожидают сохранения: ${sync.pending??'—'}. ${sync.blocked?'Нажмите «Повторить сохранение» после устранения причины.':'Повторим отправку автоматически.'}`;return;}
  if(sync.saving||sync.pending){el.textContent=`Сохраняем повторения… ${sync.pending?`Ожидают: ${sync.pending}`:''}`;return;}
  el.textContent=state?.profile?'Прогресс подтверждён сервером · видео остаётся на телефоне':'Загружаем ваш прогресс…';
}
async function applyState(next){
  if(!next||!Number.isFinite(next.serverNow)||!Array.isArray(next.days)||!Array.isArray(next.rounds)||!Array.isArray(next.competitions))throw new ApiError('API_RESPONSE_INVALID',200);
  state=next;
  $('auth-panel').hidden=true;
  if(!state.profile){
    const preferredName=getTestUser()||'Участник';
    await api('profile',{method:'POST',body:{displayName:preferredName,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}});
    state=await api('state');
  }
  const owner=profileStorageId(state.profile.id);
  if(outbox&&outboxOwner!==owner){outbox.close();outbox=null;outboxReady=false;}
  if(!outbox){
    outboxOwner=owner;
    outbox=new Outbox(owner,{api,onStatus:status=>{if(outboxOwner!==owner||!state?.profile)return;sync=status;if(status.state&&status.state.serverNow>=state.serverNow){state=status.state;renderData();}else if(state?.weekly)weekly.render(state,sync,tab==='training');setConnection();if(!status.pending&&!status.saving)refreshQuietly();}});
    try{await outbox.init();outboxReady=true;}catch(error){outbox.close();outbox=null;outboxReady=false;throw error;}
  }
  renderData();setConnection();renderTraining(engine.state);
}
async function load(){
  if(loading)return;
  loading=true;loadError=null;showError('');setConnection();
  try{
    await applyState(await api('state'));
    const ownRound=sessionStorage.getItem(`movement.active.${profileStorageId(state.profile.id)}`);
    const isReload=performance.getEntriesByType('navigation')[0]?.type==='reload'||document.wasDiscarded;
    if(!isReload)sessionStorage.removeItem(`movement.active.${profileStorageId(state.profile.id)}`);
    if(isReload&&state.activeRound?.id===ownRound){await api(`rounds/${ownRound}/abort`,{method:'POST',body:{}});sessionStorage.removeItem(`movement.active.${profileStorageId(state.profile.id)}`);try{localStorage.setItem(finalKey(),JSON.stringify({id:ownRound,status:'interrupted'}));}catch{}await applyState(await api('state'));showError('Предыдущая незавершённая попытка прервана. Её повторения останутся в дневном задании.');}
    await retryFinalization();
    const sent=await outbox.flush();if(sent)await applyState(sent);
    if(receivedInvite)await previewInvitation();
  }catch(error){
    loadError=error;
    $('auth-panel').hidden=false;
    if(error.status===401){
      $('auth-panel').hidden=false;
      const input=$('test-username-input');
      if(input&&!input.value)input.value=getTestUser();
      text('connection','Войдите, чтобы открыть свой профиль и результаты.');
    }
    else{showError(errorMessage(error));text('connection','Не удалось загрузить прогресс.');}
    diagnostics.error(error.status===401?'AUTH_REQUIRED':error.code);
  }finally{loading=false;setConnection();renderTraining(engine.state);}
}
let quietBusy=false;
async function refreshQuietly(){
  if(quietBusy||loading||authBusy||!navigator.onLine)return;
  if(!state?.profile){await load();return;}
  quietBusy=true;
  try{await applyState(await api('state'));loadError=null;}catch{/* Pending state remains unconfirmed; next refresh retries. */}finally{quietBusy=false;}
}
function renderData(){
  const s=state;if(!s?.profile)return;
  text('profile-toggle',s.profile.displayName||'Мой профиль');
  if(document.activeElement!==$('display-name'))$('display-name').value=s.profile.displayName;
  text('profile-timezone',`Часовой пояс: ${s.profile.timeZone}. Сохранён в профиле.`);
  if($('profile-panel').hidden)$('rankings-excluded').checked=!s.profile.rankingsEnabled;
  text('today-date',new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',weekday:'long',timeZone:'UTC'}).format(new Date(`${s.today.date}T12:00:00Z`)));
  text('daily-number',s.today.count);$('daily-bar').value=Math.min(10,s.today.count);
  text('daily-label',s.today.completed?'Задание выполнено · +10 баллов':`Сегодня ${s.today.count} из 10`);
  text('daily-description',s.today.completed?'Награда за сегодня уже начислена. Двигайтесь дальше в своём темпе.':'Можно за несколько подходов. Все засчитанные приседания идут в дневное задание.');
  text('regularity-points',s.points);text('last-seven',`${s.last7} из 7`);
  renderCalendar();renderCompetitions();renderProgress();weekly.render(s,sync,tab==='training');
}
function renderCalendar(){
  if(!state)return;
  const [year,month]=state.today.date.split('-').map(Number),cursor=new Date(Date.UTC(year,month-1+calendarOffset,1));
  text('calendar-month',new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(cursor));
  $('month-next').disabled=calendarOffset>=0;
  const map=new Map(state.days.map(d=>[d.date,d]));
  const prefix=`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}-`;
  const offset=(cursor.getUTCDay()+6)%7,total=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,0)).getUTCDate();
  let html='<span aria-hidden="true"></span>'.repeat(offset);
  for(let day=1;day<=total;day++){
    const date=prefix+String(day).padStart(2,'0'),row=map.get(date),completed=!!row?.completed;
    html+=`<div class="calendar-day ${completed?'complete ':''}${date===state.today.date?'today ':''}${date>state.today.date?'future':''}" aria-label="${escape(date)}: ${completed?'задание выполнено':`${row?.count||0} приседаний`}" ${date===state.today.date?'aria-current="date"':''}>${day}</div>`;
  }
  $('calendar').innerHTML=html;
}
function renderProgress(){
  const p=comparableRounds(state.rounds,RULES_VERSION);
  text('last-result',p.last?.count??'—');text('personal-record',p.record?.count??p.record??'—');
  text('result-comparison',!p.last?'Первый завершённый раунд станет вашей исходной точкой.':!p.previous?'Первая завершённая минута — ваша исходная точка. После следующей появится сравнение.':`Предыдущий результат — ${p.previous.count}. ${p.delta>0?`На ${p.delta} повторения больше`:p.delta<0?`На ${Math.abs(p.delta)} повторения меньше`:'Столько же повторений'}.`);
  $('round-history').innerHTML=p.history.length?p.history.map(r=>`<div class="history-row"><div>${escape(dateLabel(r.finishedAt||r.endsAt,{day:'numeric',month:'short',year:'numeric'}))}<small>${escape(dateLabel(r.finishedAt||r.endsAt,{hour:'2-digit',minute:'2-digit'}))}</small></div><span>${r.kind==='competition'?'Соревнование':'Личный раунд'}<small>${escape(r.rulesVersion)}</small></span><strong>${r.count}</strong></div>`).join(''):'<p class="empty-state">Пока нет завершённых минутных раундов.<br>Попробуйте «Мой результат за 60 секунд».</p>';
  const history=[...p.history].reverse();
  if(!history.length){$('progress-chart').innerHTML='<p class="chart-empty">Здесь появятся ваши результаты. Первый раунд станет началом графика.</p>';return;}
  const rows=history.slice(-30),max=Math.max(10,...rows.map(r=>r.count)),width=680,height=190;
  const points=rows.map((r,i)=>({x:rows.length===1?width/2:35+i*(width-70)/(rows.length-1),y:150-r.count/max*125,r}));
  const line=points.map(p=>`${p.x},${p.y}`).join(' ');
  $('progress-chart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Результаты последних ${rows.length} минутных раундов: ${rows.map(r=>r.count).join(', ')}"><path d="M35 150H645" stroke="#e1e8d7"/>${[0,max].map(n=>`<text x="8" y="${154-n/max*125}" font-size="10" fill="#94a184">${n}</text>`).join('')}<polyline points="${line}" stroke="#89b350" stroke-width="3" fill="none"/>${points.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="5" fill="#83a94f"><title>${escape(dateLabel(p.r.endsAt))}: ${p.r.count}</title></circle>`).join('')}<text x="35" y="180" font-size="11" fill="#94a184">${escape(dateLabel(rows[0].endsAt))}</text><text x="645" y="180" text-anchor="end" font-size="11" fill="#94a184">${escape(dateLabel(rows.at(-1).endsAt))}</text></svg>`;
}
function renderCompetitions(){
  const rows=state.competitions;
  $('competition-list').innerHTML=rows.length?rows.map(c=>{
    const statuses={invited:'Ждёт друга',active:'Предварительные результаты',settling:'Завершаем последние попытки',finished:'Итог',cancelled:'Вызов отменён'};
    const result=c.result?(c.result.type==='not_held'?'Не состоялось':c.result.type==='tie'?'Ничья':`Победа: ${c.participants.find(p=>p.role===c.result.winner)?.name||'участник'}`):'';
    const savedInvite=readInvite(c.id);
    return `<article class="card competition-card"><div class="card-top"><strong>60 секунд · до трёх попыток</strong><span class="pill">${statuses[c.status]||'Соревнование'}</span></div><div class="competition-players">${['creator','opponent'].map(role=>{
      const p=c.participants.find(p=>p.role===role);
      return `<div class="player"><strong>${p?escape(p.name)+(p.isYou?' · вы':''):c.status==='cancelled'?'Без участника':'Ждём друга'}</strong><div class="score">${p?.best??'—'}</div><p>${p?`Осталось попыток: ${p.attemptsLeft} из 3`:c.status==='cancelled'?'Приглашение недействительно':'Откроет ссылку и примет вызов'}</p>${p?.activeAttempt?'<p>Попытка идёт</p>':''}</div>`;
    }).join('')}</div><p>${c.status==='cancelled'?'Приглашение больше не действует. Попытки не израсходованы.':c.expiresAt?`До ${escape(dateLabel(c.expiresAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))}`:'24 часа начнутся после принятия приглашения'} · ${escape(c.rulesVersion)}</p>${result?`<p class="competition-result">${escape(result)}</p>`:''}${c.canStart?`<button class="button primary" data-attempt="${escape(c.id)}">Подготовить попытку</button>`:''}${savedInvite&&c.status==='invited'?`<button class="button secondary" data-invite="${escape(c.id)}">Показать ссылку другу</button>`:''}${c.canCancel?`<button class="button secondary" data-cancel-challenge="${escape(c.id)}">Отменить вызов</button><p class="muted">Можно отменить, пока друг не принял приглашение.</p>`:''}${c.rulesVersion!==RULES_VERSION?'<p>Другая версия правил. Обновите приложение для участия.</p>':''}</article>`;
  }).join(''):'<div class="empty-state">Пока нет соревнований.<br>Создайте приглашение или откройте ссылку от друга.</div>';
  document.querySelectorAll('[data-attempt]').forEach(b=>b.onclick=()=>chooseMode('competition',b.dataset.attempt));
  document.querySelectorAll('[data-invite]').forEach(b=>b.onclick=()=>showCreatedInvite(readInvite(b.dataset.invite)));
  document.querySelectorAll('[data-cancel-challenge]').forEach(b=>b.onclick=()=>cancelChallenge(b.dataset.cancelChallenge));
  const created=activeInvitation&&rows.find(c=>c.id===activeInvitation.id);
  $('cancel-created-challenge').hidden=!(created?.canCancel??activeInvitation?.canCancel);
  if(created?.status==='cancelled'){$('invite-created').hidden=true;activeInvitation=null;}
}
function setTab(next){
  if(tab==='training'&&next!=='training'){cancelCountdown();engine.stopCamera('Вы перешли в другой раздел');}
  tab=next;
  for(const el of document.querySelectorAll('[data-tab]')){el.classList.toggle('active',el.dataset.tab===next);if(el.dataset.tab===next)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');}
  for(const el of document.querySelectorAll('.tab-content'))el.hidden=el.id!==`tab-${next}`;
  if(next==='competitions')weekly.activate();
  if(next!=='training')refreshQuietly();
}
function chooseMode(next,id=null){
  cancelCountdown();engine.stopCamera('Выбран новый режим');mode=next;competitionId=id;pendingStart=null;$('round-result').hidden=true;
  $('practice-mode').classList.toggle('active',next==='practice');$('practice-mode').setAttribute('aria-pressed',next==='practice');
  $('personal-mode').classList.toggle('active',next==='personal');$('personal-mode').setAttribute('aria-pressed',next==='personal');
  text('mode-title',next==='practice'?'Приседания без таймера':next==='personal'?'Мой результат за 60 секунд':'Соревновательная попытка · 60 секунд');
  text('mode-description',next==='practice'?'Любой удобный темп, подходы и паузы. Повторения сохраняются в дневном задании.':next==='personal'?'Подготовиться → положение 2 секунды → 5–4–3–2–1 → ровно 60 секунд. Пауза недоступна. Уход в фон или выключение камеры прерывает попытку.':'Подготовиться → положение 2 секунды → 5–4–3–2–1 → 60 секунд. Попытка расходуется при запуске таймера. Досрочное завершение тоже расходует попытку.');
  text('session-tag',next==='practice'?'ЭТОТ ПОДХОД':next==='personal'?'ЛИЧНЫЙ РАУНД':'СОРЕВНОВАНИЕ');
  setTab('training');renderTraining(engine.state);
}
function renderTraining(s){
  lastTraining=s;updateDiagnostics(s);
  if(!s.cameraOn&&!s.starting&&!busy){cameraLease.release();localPracticeSession=false;}
  text('count',s.count);$('count').setAttribute('aria-label',`Повторений: ${s.count}`);
  text('camera-status',s.starting?'Подготовка камеры…':s.cameraStatus);
  $('camera-empty').hidden=s.cameraOn;
  $('video-layer').classList.toggle('mirror',s.facing==='user');
  text('facing-label',s.facing==='user'?'Передняя камера · зеркало':'Задняя камера');
  const timed=mode!=='practice',running=s.roundStatus==='running';
  const localPractice=localPracticeSession||!state?.profile||!outboxReady;
  $('local-practice-note').hidden=!localPractice;
  text('local-practice-note',timed?'Минутные раунды и дуэли требуют подключения к профилю. Выберите «Обычная тренировка», чтобы проверить камеру.':'Проверка без профиля: камера и счётчик работают. Повторения этого теста не сохраняются и не отправляются на сервер.');
  const preparing=timed&&preparation.pending,ps=preparation.status;
  text('state',ps==='error'?'Запуск не подтверждён':ps==='starting'?'Подтверждаем запуск…':ps==='countdown'?'Положение определено':ps==='waiting'?'Ожидаем исходное положение':s.paused?'Пауза':s.starting?'Загрузка модели':s.reason);
  text('hint',preparing?(s.poseReady?'Встаньте в кадр в исходное положение. Отсчёт начнётся автоматически':s.hint):s.hint);
  const announcement=visualSignal&&performance.now()<visualSignal.until?visualSignal.message:null;
  $('countdown').hidden=ps!=='countdown'&&ps!=='starting'&&!announcement;
  text('countdown',ps==='starting'?'Ждём подтверждения':ps==='countdown'?preparation.number:announcement||'');
  $('preparation-status').hidden=!preparing&&ps!=='error';
  $('preparation-status').classList.toggle('failed',ps==='error');
  text('preparation-status',(ps==='error'?($('app-error').textContent||'Сервер не подтвердил запуск. Нажмите «Подготовиться», чтобы повторить.'):ps==='countdown'?`Положение определено · ${preparation.number}`:ps==='starting'?'Ждём подтверждения сервера. Начинайте только после сигнала «Старт».':'Встаньте в кадр в исходное положение. Отсчёт начнётся автоматически')+(sound.enabled&&/недоступен|приостановил|Не удалось/.test($('sound-status').textContent)?' · Звук недоступен: следите за экраном.':''));text('model-status',`Pose Landmarker Full · ${s.modelStatus}`);
  $('timer').hidden=!timed;const sec=Math.ceil(Math.max(0,s.timerMs)/1000);text('timer',`${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`);
  $('pause').hidden=timed;$('reset').hidden=timed;
  $('pause').disabled=!s.cameraOn||s.starting||busy;$('reset').disabled=busy||s.starting;
  text('pause',s.paused?'Продолжить':'Пауза');
  $('early-stop').hidden=!running;$('early-stop').disabled=busy;
  $('stop').disabled=!s.cameraOn&&!s.starting;
  $('switch-camera').disabled=running||preparing||busy||s.starting;
  $('practice-mode').disabled=running||preparing||roundSaving;$('personal-mode').disabled=running||preparing||roundSaving;
  $('start').hidden=running||preparing;
  $('cancel-preparation').hidden=!preparing;
  $('sound-controls').hidden=!timed;
  $('start').disabled=busy||roundSaving||s.starting||(timed&&localPractice)||(!timed&&s.cameraOn&&!s.paused);
  text('start',roundSaving?'Сохраняем результат…':timed?'Подготовиться':!s.cameraOn?'Начать':'Продолжить');
  $('diag-values').innerHTML=Object.entries({Модель:'Pose Landmarker Full',Правила:RULES_VERSION,Камера:s.resolution,'Кадров/с':s.fps,'Обработка, мс':s.inferenceMs,Состояние:s.phase}).map(([k,v])=>`<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('');
}
async function saveRepetition(event){
  if(localPracticeSession||!outboxReady||!outbox)return;
  try{await outbox.add({id:crypto.randomUUID(),...event});persistenceError=false;}catch{persistenceError=true;engine.mode==='practice'?engine.pause():engine.abortRound('Не удалось сохранить повторение');diagnostics.error('LOCAL_STORAGE');setConnection();}
}
function announceSignal(kind){
  sound.play(kind);
  if(kind==='start')visualSignal={message:'Старт!',until:performance.now()+900};
  if(kind==='end')visualSignal={message:'Время вышло',until:Infinity};
}
function cancelCountdown(){visualSignal=null;preparation.cancel();sound.stop();wakeLock.release();}
function updateDiagnostics(s){diagnostics.update({...s,mode,preparationStatus:preparation.status,soundEnabled:sound.enabled,soundAvailable:sound.context?.state==='running',apiConnection:getConnectionDiagnostic()});}
async function start(){
  if(busy||roundSaving||preparation.pending||(mode!=='practice'&&(!state?.profile||!outboxReady)))return;
  showError('');$('round-result').hidden=true;
  visualSignal=null;
  if(mode==='practice'){if(!engine.state.cameraOn)localPracticeSession=!state?.profile||!outboxReady;busy=true;renderTraining(engine.state);try{if(await acquireCamera()){wakeLock.acquire();await engine.startPractice();}}finally{busy=false;renderTraining(engine.state);}return;}
  // AudioContext is created/resumed inside this user gesture, before awaiting
  // the camera permission. Only this explicit action can arm automatic start.
  const audioReady=sound.enabled?sound.unlock():Promise.resolve(false);
  const generation=preparation.arm();busy=true;
  if(matchMedia('(max-width: 640px)').matches)$('preparation-status').scrollIntoView({block:'start',behavior:'smooth'});
  try{
    if(!await acquireCamera()){preparation.fail();return;}
    wakeLock.acquire();
    if(generation!==preparation.generation)return;
    const ready=await engine.prepareRound(mode);
    if(!ready||document.hidden){preparation.cancel();wakeLock.release();return;}
    preparation.wait(generation);
  }finally{await audioReady;busy=false;renderTraining(engine.state);}
}
async function launchRound({isCurrent}){
  if(!isCurrent()||document.hidden)return false;
  const permit=engine.captureStartPermit();
  if(!permit){showError('Исходное положение изменилось перед запуском. Нажмите «Подготовиться» и повторите.');diagnostics.error('START_POSE_LOST');return false;}
  diagnostics.startEvent('requesting');
  busy=true;renderTraining(engine.state);
  pendingStart??={requestId:crypto.randomUUID(),kind:mode,...(competitionId?{competitionId}:{})};
  const requestStarted=performance.now();let round=null;
  try{
    const response=await api('rounds/start',{method:'POST',body:pendingStart});
    round=response.round;pendingStart=null;
    if(round.status!=='active'||response.serverNow>=round.endsAt)throw new ApiError('ROUND_INTERRUPTED',409);
    sessionStorage.setItem(`movement.active.${profileStorageId(state.profile.id)}`,round.id);
    const receivedAt=performance.now(),serverAtReceipt=serverTimeAtReceipt(response,receivedAt-requestStarted);
    const serverNow=serverAtReceipt+performance.now()-receivedAt;
    if(!isCurrent()||document.hidden||!engine.beginRound({...round,serverNow},permit)){
      await api(`rounds/${round.id}/abort`,{method:'POST',body:{}});
      sessionStorage.removeItem(`movement.active.${profileStorageId(state.profile.id)}`);
      diagnostics.startEvent('cancelled',performance.now()-requestStarted);
      showError('Запуск отменён. Если сервер уже запустил минуту, попытка отмечена как прерванная.');return false;
    }
    diagnostics.startEvent('confirmed',performance.now()-requestStarted);return true;
  }catch(error){diagnostics.startEvent('rejected',performance.now()-requestStarted);showError(errorMessage(error));diagnostics.error('ROUND_START_FAILED');return false;}
  finally{busy=false;renderTraining(engine.state);refreshQuietly();}
}
async function acquireCamera(){
  if(await cameraLease.acquire())return true;
  showError(cameraLease.supported?'Камера используется другой вкладкой этого приложения. Выключите камеру в ней и повторите запуск.':'Откройте приложение в актуальном Chrome: нужна поддержка безопасного запуска камеры в одной вкладке.');
  return false;
}
function finalKey(){return `movement.finalization.${profileStorageId(state?.profile?.id)}`;}
async function saveRound(result){
  if(!result.id||!state?.profile)return;
  if(result.status==='completed')preparation.complete();else preparation.cancel();
  roundSaving=true;
  try{localStorage.setItem(finalKey(),JSON.stringify({id:result.id,status:result.status}));}catch{diagnostics.error('LOCAL_STORAGE');}
  renderTraining(engine.state);
  $('round-result').hidden=false;text('round-result',result.status==='completed'?'Время вышло. Подтверждаем результат на сервере…':'Попытка прервана. Сохраняем уже засчитанные повторения…');
  try{await finalize(result);}
  catch(error){
    if(error.code==='ROUND_INTERRUPTED'){
      localStorage.removeItem(finalKey());sessionStorage.removeItem(`movement.active.${profileStorageId(state.profile.id)}`);
      $('round-result').innerHTML='<h2>Попытка прервана</h2><p>Сервер не получил завершение вовремя. Рекорд не создан; сохранённые повторения остаются в дневном задании.</p>';
      await refreshQuietly();
    }else{showError(errorMessage(error));$('round-result').innerHTML='<h2>Результат ещё не подтверждён</h2><p>Не закрывайте страницу. Повторите отправку после восстановления сети.</p><button id="retry-round" class="button secondary">Повторить сохранение</button>';$('retry-round').onclick=()=>saveRound(result);diagnostics.error('SAVE_FAILED');}
  }
  finally{roundSaving=false;renderTraining(engine.state);}
}
async function finalize(result){
  // Each event is persisted locally before transmission. Flush all repetitions
  // before finishing; retry uses the same round ID and event UUIDs.
  await Promise.all([...pendingWrites]);
  if(persistenceError)throw new Error('local persistence failed');
  const sent=await outbox.flush();if(sent)await applyState(sent);
  if(await outbox.count())throw new Error('pending');
  if(result.status==='completed')await new Promise(resolve=>setTimeout(resolve,200));
  let response;
  try{response=await api(`rounds/${result.id}/${result.status==='completed'?'finish':'abort'}`,{method:'POST',body:{},keepalive:result.status!=='completed'});}
  catch(error){
    if(result.status!=='completed'||error.code!=='ROUND_RUNNING')throw error;
    await new Promise(resolve=>setTimeout(resolve,600));
    response=await api(`rounds/${result.id}/finish`,{method:'POST',body:{}});
  }
  if(response.state)await applyState(response.state);else await refreshQuietly();
  localStorage.removeItem(finalKey());
  sessionStorage.removeItem(`movement.active.${profileStorageId(state.profile.id)}`);
  const completed=response.round?.status==='completed';
  $('round-result').innerHTML=completed?`<h2>Время вышло · ${response.round.count} приседаний за минуту</h2><p>Результат сохранён. ${escape($('result-comparison').textContent)}</p><button id="see-progress" class="button secondary">Посмотреть мой прогресс</button>`:'<h2>Попытка прервана</h2><p>Она не участвует в рекордах. Подтверждённые повторения учтены в дневном задании.</p>';
  $('see-progress')?.addEventListener('click',()=>setTab('progress'));
}
async function retryFinalization(){
  let saved;try{saved=JSON.parse(localStorage.getItem(finalKey())||'null');}catch{return;}
  if(!saved?.id)return;
  // An active round never resumes after reload. A completed local minute may
  // only be confirmed during the server's bounded finish-delivery grace.
  if(state.activeRound?.id===saved.id)saved.status='interrupted';
  try{await finalize(saved);}catch{showError('Есть неподтверждённая попытка. Сервер не включит её в рекорд без завершения.');}
}
function token(){return [...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function inviteKey(id){return `movement.invite.${profileStorageId(state.profile.id)}.${id}`;}
function readInvite(id){try{return JSON.parse(localStorage.getItem(inviteKey(id))||'null');}catch{return null;}}
function showCreatedInvite(invitation){
  if(!invitation)return;activeInvitation=invitation;$('invite-created').hidden=false;$('invite-url').value=`${invitationOrigin(location.origin)}/#invite=${invitation.token}`;
  $('cancel-created-challenge').hidden=!(state?.competitions.find(c=>c.id===invitation.id)?.canCancel??invitation.canCancel);
}
async function cancelChallenge(id){
  if(busy||!state?.profile)return;busy=true;showError('');
  document.querySelectorAll('[data-cancel-challenge],#cancel-created-challenge').forEach(b=>b.disabled=true);
  try{
    const response=await api(`competitions/${id}/cancel`,{method:'POST',body:{}});
    localStorage.removeItem(inviteKey(id));
    await applyState(response.state);
  }catch(error){showError(errorMessage(error));await refreshQuietly();}
  finally{busy=false;document.querySelectorAll('[data-cancel-challenge],#cancel-created-challenge').forEach(b=>b.disabled=false);}
}
async function createChallenge(){
  if(!state?.profile||busy)return;busy=true;$('create-challenge').disabled=true;showError('');
  const key=`movement.create.${profileStorageId(state.profile.id)}`;
  let request;try{request=JSON.parse(localStorage.getItem(key)||'null');}catch{}
  request??={requestId:crypto.randomUUID(),token:token()};
  try{
    localStorage.setItem(key,JSON.stringify(request));
    const response=await api('competitions',{method:'POST',body:request});
    const invite={id:response.competition.id,token:request.token,canCancel:response.competition.canCancel};localStorage.setItem(inviteKey(invite.id),JSON.stringify(invite));localStorage.removeItem(key);
    showCreatedInvite(invite);await refreshQuietly();
  }catch(error){showError(errorMessage(error));diagnostics.error('INVITATION_FAILED');}
  finally{busy=false;$('create-challenge').disabled=false;}
}
async function previewInvitation(){
  setTab('competitions');$('invite-accept').hidden=false;$('accept-challenge').disabled=true;
  try{
    const response=await api('invitations/preview',{method:'POST',body:{token:receivedInvite}}),p=response.preview||response;
    text('invite-preview',p.status==='cancelled'?'Автор отменил вызов. Это приглашение больше не действует. Попросите друга создать новое.':`${p.creatorName} приглашает вас: три попытки по 60 секунд, 24 часа после принятия. ${p.canAccept?'После принятия начнётся общий срок.':'Приглашение уже занято или недоступно для вашего профиля.'}`);
    $('accept-challenge').disabled=!p.canAccept;
  }catch(error){text('invite-preview',errorMessage(error));}
}
$('accept-challenge').onclick=async()=>{
  $('accept-challenge').disabled=true;
  try{const r=await api('invitations/accept',{method:'POST',body:{token:receivedInvite}});await applyState(r.state);sessionStorage.removeItem('movement.receivedInvite');receivedInvite=null;$('invite-accept').hidden=true;showError('');}
  catch(error){showError(errorMessage(error));$('accept-challenge').disabled=false;}
};
$('profile-toggle').onclick=()=>{if($('profile-panel').hidden)openProfile();else closeProfile(true);};
$('profile-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const response=await api('profile',{method:'POST',body:{displayName:$('display-name').value,timeZone:state.profile.timeZone,rankingsEnabled:!$('rankings-excluded').checked}});await applyState(response.state);closeProfile(false);}catch(error){showError(errorMessage(error));}finally{button.disabled=false;}};
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>setTab(button.dataset.tab);
$('today-train').onclick=()=>chooseMode('practice');$('practice-mode').onclick=()=>chooseMode('practice');$('personal-mode').onclick=()=>chooseMode('personal');
$('start').onclick=start;
$('cancel-preparation').onclick=()=>{cancelCountdown();engine.stopCamera('Подготовка отменена');cameraLease.release();wakeLock.release();};
$('sound-enabled').onchange=event=>{sound.setEnabled(event.target.checked);if(sound.enabled)sound.unlock();else text('sound-status','Звук выключен. Ориентируйтесь на экран.');};
$('test-sound').onclick=async()=>{if(!sound.enabled){text('sound-status','Включите «Звук», чтобы проверить сигнал.');return;}if(await sound.unlock()){sound.stop();if(sound.play('start'))text('sound-status','Проверочный сигнал воспроизведён. Проверьте громкость телефона.');}};$('pause').onclick=()=>engine.state.paused?engine.resume():engine.pause();$('reset').onclick=()=>engine.reset();
$('stop').onclick=()=>{cancelCountdown();engine.stopCamera();cameraLease.release();wakeLock.release();};$('early-stop').onclick=()=>{engine.abortRound('Завершено досрочно');wakeLock.release();};$('switch-camera').onclick=async()=>{cancelCountdown();busy=true;try{await engine.switchCamera();}finally{busy=false;renderTraining(engine.state);}};$('show-points').onchange=e=>engine.setOverlay(e.target.checked);
$('month-prev').onclick=()=>{calendarOffset--;renderCalendar();};$('month-next').onclick=()=>{calendarOffset=Math.min(0,calendarOffset+1);renderCalendar();};
$('create-challenge').onclick=createChallenge;$('refresh-challenges').onclick=refreshQuietly;
$('cancel-created-challenge').onclick=()=>{if(activeInvitation)cancelChallenge(activeInvitation.id);};
$('retry-sync').onclick=async()=>{if(loadError||!outbox){await load();return;}try{const saved=await outbox.flush({retryFailed:true});if(saved)await applyState(saved);}catch(error){showError(errorMessage(error));}};
$('check-server').onclick=()=>load();
$('server-form').onsubmit=event=>{
  event.preventDefault();
  try{
    if(engine.state.cameraOn||engine.state.starting||busy||roundSaving||preparation.pending)throw new Error('Выключите камеру и дождитесь окончания текущего действия перед сменой сервера.');
    setNativeApiUrl($('server-url').value);
    outbox?.close();
    location.reload();
  }catch(error){text('server-result',error.message);}
};
$('copy-invite').onclick=async()=>{const success=await copyReport($('invite-url'));text('invite-copy-status',success?'Ссылка скопирована. Отправьте её другу.':'Выделите ссылку и скопируйте вручную.');};
$('copy').onclick=async()=>{updateDiagnostics(engine.state);$('copy-fallback').value=diagnostics.reportText();const ok=await copyReport($('copy-fallback'));text('copy-status',ok?'Диагностика скопирована. Вставьте её в чат.':'Отчёт подготовлен ниже. Выделите его и скопируйте вручную.');};$('select-report').onclick=()=>selectReport($('copy-fallback'));
window.addEventListener('online',()=>{setConnection();refreshQuietly();});window.addEventListener('offline',setConnection);
window.addEventListener('hashchange',()=>{
  const invitation=location.hash.match(/^#invite=([a-f0-9]{64})$/);
  if(!invitation)return;
  receivedInvite=invitation[1];sessionStorage.setItem('movement.receivedInvite',receivedInvite);
  history.replaceState(null,'',location.pathname+location.search);
  if(state?.profile)previewInvitation();
});
window.addEventListener('popstate',()=>{
  if(!$('profile-panel').hidden)closeProfile(false);
});
window.addEventListener('storage',event=>{if(event.key?.startsWith('movement.'))refreshQuietly();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelCountdown();wakeLock.release();}else{refreshQuietly();}});
// Keep the interruption write small and synchronous to initiate while the page
// is leaving. Server timeout also marks an unconfirmed attempt aborted.
window.addEventListener('pagehide',()=>{cameraLease.release();wakeLock.release();const round=engine.clock.id;if(round&&engine.roundStatus!=='completed'){api(`rounds/${round}/abort`,{method:'POST',body:{},keepalive:true}).catch(()=>{});}});
const quickGuestBtn=$('quick-guest-btn');
async function login(name){
  if(authBusy||loading)return;
  authBusy=true;quickGuestBtn.disabled=true;$('test-login-btn').disabled=true;
  try{await signInGuest(name);$('auth-panel').hidden=true;await load();}
  catch(error){showError(errorMessage(error));}
  finally{authBusy=false;quickGuestBtn.disabled=false;$('test-login-btn').disabled=false;}
}
if(quickGuestBtn){
  quickGuestBtn.onclick=async()=>{
    const rand=Math.floor(100+Math.random()*900);
    const guestName=`Атлет-${rand}`;
    await login(guestName);
  };
}
const testLoginForm=$('test-login-form');
if(testLoginForm){
  testLoginForm.onsubmit=async event=>{
    event.preventDefault();
    const name=($('test-username-input')?.value||'').trim();
    if(!name){showError('Введите имя для входа.');return;}
    if(name.length>40){showError('Имя не должно превышать 40 символов.');return;}
    await login(name);
  };
}
const signOutBtn=$('sign-out-btn');
if(signOutBtn){
  signOutBtn.onclick=async()=>{
    if(authBusy||loading||busy||roundSaving||engine.state.roundStatus==='running'){showError('Дождитесь завершения текущего действия перед выходом.');return;}
    authBusy=true;signOutBtn.disabled=true;
    try{
    cancelCountdown();engine.stopCamera();
    await Promise.all([...pendingWrites]);
    if(outbox&&await outbox.count()){showError('Сначала дождитесь сохранения повторений, затем выйдите из профиля.');return;}
    await signOutDevice();
    outboxOwner=null;
    state=null;
    if(outbox){outbox.close();outbox=null;outboxReady=false;}
    closeProfile(false);
    $('auth-panel').hidden=false;
    text('connection','Войдите, чтобы открыть свой профиль и результаты.');
    text('profile-toggle','Мой профиль');
    renderTraining(engine.state);
    }catch(error){showError(errorMessage(error));}
    finally{authBusy=false;signOutBtn.disabled=false;}
  };
}
const apkBox=document.querySelector('.apk-download-box');
if(apkBox)apkBox.hidden=true;
if(!isNativeApp())fetch('/app-debug.apk.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(info=>{if(apkBox&&info?.version===VERSION)apkBox.hidden=false;}).catch(()=>{});
if(isNativeApp()){
  $('server-settings').hidden=false;
  $('server-url').value=getApiBaseUrl();
}
if(!isNativeApp() && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  });
}
refreshTimer=setInterval(()=>{if(!document.hidden&&tab!=='training')refreshQuietly();},30000);
renderTraining(engine.state);load();
