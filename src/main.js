import './style.css';
import {Camera,cameraError} from './camera.js';
import {Vision} from './models.js';
import {MotionVision} from './motion.js';
import {AutoProfile} from './auto-profile.js';
import {FrameCadence} from './frame-cadence.js';
import {Diagnostics} from './diagnostics.js';
import {copyReport,selectReport} from './clipboard.js';
import {ExerciseSession} from './session.js';
import {squatFeatures} from './algorithms/squat.js';
import {clapFeatures} from './algorithms/clap.js';
import {MODELS,SETTLE_MS,HAND_INPUT_MAX_EDGE,MOTION} from './config.js';
import {drawOverlay} from './overlay.js';
import {$,names,renderMode,renderCount,renderState,renderDiagnostics} from './ui.js';
const session=new ExerciseSession(),diag=new Diagnostics();
const video=$('video'),overlay=$('overlay');
let active=false,starting=false,run=0,facing='user',modelStatus='Не загружена',settleUntil=0,readyAt=null,lastFrame=-1,lastSent=-Infinity,lastMediaSent=-Infinity,capturing=false,frameCallback=null,frameKind=null;
let lastView={phase:'baseline',reason:'Камера выключена'},lastLandmarks=[];
let lastDiagnosticsPaint=-Infinity;
const autoProfile=new AutoProfile();
const neuralCadence=new FrameCadence();
let hybrid=false,lastMotionSent=-Infinity,lastMotionBothAt=null,firstNeuralBothAt=null,lastUiPaint=-Infinity,lastOverlayPaint=-Infinity;
let weakMotionWarned=false;
let cameraFrames=[],lastCameraTime=-1,adapting=false,lastMovementAt=0;
const modelKey=()=>session.mode==='clap'?'hands':$('pose-model').value;
const clearOverlay=()=>{lastLandmarks=[];overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);};
const camera=new Camera(video,()=>fail(new Error('Видеопоток прерван. Нажмите «Начать», чтобы снова включить камеру.')));
const motion=new MotionVision({onResult:processMotion,onError:motionFallback,onAnchor:data=>{diag.values.motionAnchor=data;},onPreview:data=>{
  if(!active||!hybrid||session.paused||document.hidden||data.epoch!==session.epoch)return;
  paintOverlay(data.landmarks);
}});
function motionFallback(message){
  hybrid=false;motion.close();diag.values.trackingSource='Только модель';diag.values.motionFallback=String(message);
  diag.event(`Быстрый трекер: ${message}. Резерв — Hand Landmarker.`);
  if(active&&session.mode==='clap')resetTracking('Резервное распознавание: подтвердите исходное положение');
}
const vision=new Vision({onStatus:s=>{
  modelStatus=s;$('model-status').textContent=s;
  $('model-dot').className=`status-dot ${s==='Готово'?'live':'loading'}`;
  if(starting)renderState('Загрузка модели',camera.stream?s:'Разрешите камеру и дождитесь завершения загрузки.');
  updateDiag();
},onResult:processResult,onError:e=>fail(e),onBackend:info=>{
  for(const key of ['delegate','backendStatus','backendBenchmark','fallbackReason'])diag.values[key]=info[key]??null;
  diag.event(`Распознавание: ${info.delegate}; ${info.backendStatus}${info.fallbackReason?'; '+info.fallbackReason:''}`);updateDiag();
}});
function buttons(){
  $('start').disabled=active||starting;$('start').textContent=starting?'Загрузка…':'Начать';
  $('pause').disabled=!active||starting;$('pause').textContent=session.paused?'Продолжить':'Пауза';
  $('stop').disabled=!active&&!starting&&!camera.stream;
  $('camera-status').textContent=camera.stream?'Камера включена':'Камера выключена';
  $('camera-dot').className=`status-dot ${camera.stream?'live':''}`;
  $('camera-empty').hidden=!!camera.stream;$('camera-label').hidden=!camera.stream;
  const actualFacing=camera.settings.facingMode||facing;
  $('video-layer').classList.toggle('mirror',actualFacing==='user');
  $('facing-label').textContent=actualFacing==='user'?'Передняя камера · зеркало':'Задняя камера';
}
function updateDiag(force=false){
  diag.syncClap(session.algorithms.clap);
  const s=camera.settings;Object.assign(diag.values,{exercise:names[session.mode],model:MODELS[modelKey()].name,modelStatus,camera:camera.stream?`${facing==='user'?'передняя':'задняя'} · включена`:'выключена',resolution:s.width?`${s.width} × ${s.height} @ ${Math.round(s.frameRate||0)} fps`:'—',count:session.count,counts:{...session.counts},phase:session.algorithm.phase,reason:lastView.reason,metrics:lastView.metrics,paused:session.paused});
  diag.values.autoProfile=session.mode==='clap'?{...autoProfile.snapshot(),activeNeuralLimitFps:hybrid?autoProfile.neuralHz:30,camera:camera.profile}:null;
  diag.values.trackingSource=session.mode==='clap'?(hybrid?'Модель + оптический трекер':'Только модель'):'Модель';
  // Keep the snapshot current; rebuilding the expanded diagnostic DOM on every
  // camera frame wastes time on mobile. Paint it at most four times a second.
  if($('diagnostics').open&&(force===true||performance.now()-lastDiagnosticsPaint>=250)){renderDiagnostics(diag);lastDiagnosticsPaint=performance.now();}
}
function resetTracking(reason,{reacquire=false}={}){
  const wasCalibrated=session.mode==='clap'&&!!(session.algorithm.reference||session.algorithm.reacquiring);
  session.restart(reason);
  if(reacquire&&wasCalibrated)session.algorithm.beginReacquire(reason);
  motion.reset(session.epoch);neuralCadence.reset();lastFrame=-1;lastSent=-Infinity;lastMotionSent=-Infinity;lastMediaSent=-Infinity;lastMotionBothAt=null;firstNeuralBothAt=null;weakMotionWarned=false;readyAt=null;
  settleUntil=performance.now()+(reacquire?0:SETTLE_MS);lastView={phase:'baseline',reason};clearOverlay();diag.resetFps();
}
function stopLoop(){if(frameCallback!==null){if(frameKind==='video')video.cancelVideoFrameCallback(frameCallback);else cancelAnimationFrame(frameCallback);}frameCallback=null;}
function schedule(){if(!active||frameCallback!==null)return;if(video.requestVideoFrameCallback){frameKind='video';frameCallback=video.requestVideoFrameCallback(frame);}else{frameKind='animation';frameCallback=requestAnimationFrame(frame);}}
async function frame(now,metadata){
  frameCallback=null;schedule();
  const mediaTime=metadata?.mediaTime??video.currentTime;
  if(active&&mediaTime!==lastCameraTime){
    lastCameraTime=mediaTime;cameraFrames.push(mediaTime);cameraFrames=cameraFrames.filter(t=>mediaTime-t<2);
    diag.values.cameraDeliveredFps=cameraFrames.length>1?Math.round((cameraFrames.length-1)/(mediaTime-cameraFrames[0])*10)/10:0;
  }
  if(!active||starting||adapting||session.paused||document.hidden||!vision.ready||capturing||video.readyState<2)return;
  const fast=hybrid&&session.mode==='clap';
  const flowDue=fast&&motion.ready&&!motion.busy&&(mediaTime-lastMotionSent)*1000>=1000/MOTION.maxFps-2;
  const neuralInterval=session.mode==='clap'?1000/(fast?autoProfile.neuralHz:30):1000/20;
  const neuralDue=!vision.busy&&(session.mode==='clap'?neuralCadence.due(mediaTime*1000):now-lastSent>=neuralInterval);
  // A neural capture is paired with its exact optical-flow frame. Heavy
  // inference never blocks delivery to the independent image tracker.
  if(mediaTime===lastFrame||fast&&!flowDue||!fast&&!neuralDue)return;
  lastFrame=mediaTime;capturing=true;const epoch=session.epoch;
  try{
    const capture=(source,maxEdge)=>{
      const resize=Math.min(1,maxEdge/Math.max(video.videoWidth,video.videoHeight));
      return resize<1?createImageBitmap(source,{resizeWidth:Math.round(video.videoWidth*resize),resizeHeight:Math.round(video.videoHeight*resize),resizeQuality:'low'}):createImageBitmap(source);
    };
    // Snapshot the video ONCE before deriving the paired inputs. Two separate
    // async createImageBitmap(video) calls can sample different camera frames.
    const original=await createImageBitmap(video);
    let flowBitmap=null,neuralBitmap=null;
    try{
      if(fast)flowBitmap=await capture(original,autoProfile.motionEdge);
      if(neuralDue)neuralBitmap=session.mode==='clap'&&Math.max(original.width,original.height)>HAND_INPUT_MAX_EDGE?await capture(original,HAND_INPUT_MAX_EDGE):original;
    }catch(e){flowBitmap?.close();neuralBitmap?.close();throw e;}
    finally{if(neuralBitmap!==original)original.close();}
    if(!active||session.paused||epoch!==session.epoch||document.hidden){flowBitmap?.close();neuralBitmap?.close();return;}
    if(flowBitmap){lastMotionSent=mediaTime;motion.detect(flowBitmap,now,epoch);}
    if(neuralBitmap){lastSent=now;lastMediaSent=mediaTime;if(session.mode==='clap')neuralCadence.sent(mediaTime*1000,1000/neuralInterval);vision.detect(neuralBitmap,now,epoch);}
  }catch(e){if(active&&epoch===session.epoch)fail(new Error(`Не удалось обработать кадр: ${e.message}`));}finally{capturing=false;}
}
function processResult(data){
  if(!active||session.paused||document.hidden||data.epoch!==session.epoch)return;
  diag.frame(data.timestamp);diag.values.inferenceMs=Math.round(data.ms);
  diag.values.modelInput=data.inputWidth?`${data.inputWidth} × ${data.inputHeight}`:'—';
  for(const key of ['delegate','backendStatus','backendBenchmark','fallbackReason'])diag.values[key]=data[key]??null;
  const features=session.mode==='squat'?squatFeatures(data.landmarks[0],video.videoWidth,video.videoHeight,session.algorithm.side):clapFeatures(data.landmarks,data.scores,video.videoWidth,video.videoHeight);
  if(session.mode==='clap'){
    autoProfile.observeModel(data,features.valid);
    if(hybrid){
      motion.seed(data);diag.observeHands(data,features,{...lastView,increment:0});
      if(features.valid){
        // First inference can include seconds of GPU/shader warmup. Start the
        // fallback observation window at DELIVERY, not that old capture time.
        firstNeuralBothAt??=performance.now();
        if(performance.now()-(lastMotionBothAt??firstNeuralBothAt)>1600&&!weakMotionWarned){
          // Weak texture is an observation failure, not a Worker failure. The
          // old path killed the tracker permanently before adaptation could run.
          weakMotionWarned=true;diag.event('Слабые пиксельные опоры: трекер продолжает поиск, доступна автонастройка');
        }
      }
      updateDiag();return;
    }
  }
  consumeResult(data,features);
}
function processMotion(data){
  if(!active||!hybrid||session.mode!=='clap'||session.paused||document.hidden||data.epoch!==session.epoch)return;
  const features=clapFeatures(data.landmarks,[],video.videoWidth,video.videoHeight);
  autoProfile.observeMotion({...data,valid:features.valid});
  if(features.valid&&data.source!=='model-anchor'){
    lastMotionBothAt=performance.now();if(weakMotionWarned)diag.event('Пиксельное отслеживание восстановлено автоматически');weakMotionWarned=false;
  }
  if(data.discontinuity){session.algorithm.reject('Положение кистей уточнено: снова разведите ладони',data.timestamp,true);diag.event('Сброшено незавершённое движение после коррекции траектории');}
  consumeResult(data,features,true);
  const idle=session.algorithm.phase==='baseline'||session.algorithm.phase==='open'&&data.timestamp-lastMovementAt>2500;
  const decision=autoProfile.decide(data.timestamp,{idle,cameraFps:camera.settings.frameRate??0,profileId:camera.profile?.id});
  if(decision?.motionEdge){resetTracking('Автонастройка: снова разведите ладони',{reacquire:true});diag.event(autoProfile.reason);}
  if(decision?.cameraProfile&&!adapting){
    adapting=true;const epoch=session.epoch;
    camera.selectMode('clap',decision.cameraProfile).then(ok=>{if(ok&&active&&session.mode==='clap'&&epoch===session.epoch)resetTracking('Автонастройка камеры: подтвердите исходное положение');}).catch(e=>{diag.error(e);}).finally(()=>{adapting=false;updateDiag();});
  }
}
function consumeResult(data,features,isMotion=false){
  if(!isMotion)paintOverlay(data.landmarks);
  if(data.timestamp<settleUntil){renderState('Встаньте в кадр',`Займите исходное положение · ${Math.max(1,Math.ceil((settleUntil-data.timestamp)/1000))} сек`);lastView={phase:'baseline',reason:'Время на подготовку'};if(session.mode==='clap'&&!isMotion)diag.observeHands(data,features,lastView);if(isMotion)diag.observeMotion(data,features,lastView);updateDiag();return;}
  const view=session.update(features,data.timestamp,data.epoch);if(!view)return;lastView=view;
  if(session.mode==='clap'){if(isMotion)diag.observeMotion(data,features,view);else diag.observeHands(data,features,view);}
  if(!['open','baseline'].includes(view.phase)||view.increment)lastMovementAt=data.timestamp;
  let state=view.tracking?(view.ready?'Идёт подсчёт':'Встаньте в кадр'):(session.mode==='clap'?'Покажите обе руки':data.landmarks.length?'Плохо видно тело':'Встаньте в кадр');
  if(view.ready&&readyAt===null)readyAt=data.timestamp;
  if(!view.ready)readyAt=null;
  if(view.ready&&data.timestamp-readyAt<600)state='Готово';
  if(view.increment||performance.now()-lastUiPaint>=70){renderState(state,view.tracking?view.hint:features.reason||view.hint);lastUiPaint=performance.now();}
  const progress=view.ready?(view.phase==='standing'||view.phase==='open'?1:view.phase==='descending'||view.phase==='approaching'?2:3):0;
  [...$('cycle-progress').children].forEach((el,i)=>el.classList.toggle('on',i<progress));
  if(view.increment){renderCount(session.count,true);diag.event(`${names[session.mode]}: ${session.count}`);}
  updateDiag();
}
function paintOverlay(landmarks){
  lastLandmarks=landmarks;
  if(performance.now()-lastOverlayPaint>=30){drawOverlay(overlay,lastLandmarks,session.mode,video.videoWidth,video.videoHeight,$('show-points').checked);lastOverlayPaint=performance.now();}
}
let wakeLock=null;
async function requestWakeLock(){
  try{if('wakeLock' in navigator){wakeLock=await navigator.wakeLock.request('screen');}}catch{}
}
function releaseWakeLock(){
  if(wakeLock){try{wakeLock.release();}catch{}wakeLock=null;}
}

async function begin({reuseCamera=false,keepPaused=false}={}){
  const attempt=++run;starting=true;active=false;session.resume();stopLoop();resetTracking('Подготовка сеанса');$('error-box').hidden=true;modelStatus='Загрузка модели';buttons();renderState('Загрузка модели','Разрешите камеру и займите исходное положение.');
  try{
    autoProfile.reset();cameraFrames=[];lastCameraTime=-1;lastMovementAt=performance.now();
    const motionReady=session.mode==='clap'?motion.load(session.epoch):Promise.resolve(false);
    const results=await Promise.all([reuseCamera&&camera.stream?camera.selectMode(session.mode):camera.start(facing,session.mode).then(result=>{if(attempt===run)buttons();return result;}),vision.load(modelKey()),motionReady]);
    if(attempt!==run||results.slice(0,2).some(r=>r===false))return;
    hybrid=session.mode==='clap'&&results[2];diag.values.motionFallback=hybrid?null:'Быстрый трекер недоступен; используется модель';
    starting=false;active=true;resetTracking('Подтвердите исходное положение');
    if(document.hidden||keepPaused){session.pause();renderState('Пауза','Нажмите «Продолжить» и займите исходное положение.');}else{renderState('Встаньте в кадр','Займите исходное положение. Подсчёт начнётся автоматически.');requestWakeLock();}
    diag.event(`Начало: ${names[session.mode]}, ${MODELS[modelKey()].name}`);buttons();schedule();updateDiag();
  }catch(e){if(attempt===run)fail(e);}
}
function stop(reason='Камера выключена'){
  run++;active=false;starting=false;releaseWakeLock();stopLoop();vision.close();motion.close();hybrid=false;camera.stop();session.restart(reason);clearOverlay();diag.resetFps();lastView={reason};modelStatus='Не загружена';$('model-status').textContent='Распознавание остановлено';$('model-dot').className='status-dot';buttons();renderState('Камера выключена','Нажмите «Начать», когда будете готовы.');[...$('cycle-progress').children].forEach(el=>el.classList.remove('on'));updateDiag(true);
}
function fail(e){diag.error(e);stop(e.message);const isCamera=['NotAllowedError','SecurityError','NotFoundError','NotReadableError','OverconstrainedError'].includes(e.name);const message=cameraError(e);modelStatus=isCamera?'Не запущена':'Ошибка загрузки / обработки';$('model-status').textContent=modelStatus;lastView={reason:message};$('error-box').textContent=message;$('error-box').hidden=false;renderState(isCamera?'Камера недоступна':'Ошибка загрузки',message);updateDiag();}
$('start').addEventListener('click',()=>begin());
$('stop').addEventListener('click',()=>{diag.event('Камера выключена пользователем');stop();});
$('pause').addEventListener('click',()=>{
  if(session.paused){session.resume();resetTracking('Возобновление: подтвердите исходное положение');renderState('Встаньте в кадр','Снова займите исходное положение.');diag.event('Продолжение');requestWakeLock();}
  else{session.pause();releaseWakeLock();lastView={reason:'Пауза пользователем'};clearOverlay();diag.resetFps();renderState('Пауза','Нажмите «Продолжить», когда будете готовы.');diag.event('Пауза');}
  buttons();updateDiag(true);
});
$('reset').addEventListener('click',()=>{session.reset();resetTracking('Счётчик сброшен');renderCount(0);diag.event(`Сброс: ${names[session.mode]}`);if(active)renderState(session.paused?'Пауза':'Встаньте в кадр',session.paused?'Счётчик сброшен. Нажмите «Продолжить».':'Снова займите исходное положение.');updateDiag();});
for(const mode of ['squat','clap'])$(`mode-${mode}`).addEventListener('click',()=>{
  if(mode===session.mode)return;const wasActive=active||starting;const wasPaused=session.paused;
  run++;stopLoop();vision.close();motion.close();hybrid=false;active=false;starting=false;session.select(mode);renderMode(mode);renderCount(session.count);clearOverlay();diag.event(`Выбрано: ${names[mode]}`);
  if(wasActive){begin({reuseCamera:true,keepPaused:wasPaused});}else{renderState('Камера выключена','Включите камеру, чтобы начать.');lastView={reason:'Смена упражнения'};modelStatus='Не загружена';$('model-status').textContent='Распознавание ещё не запущено';buttons();updateDiag();}
});
$('switch-camera').addEventListener('click',()=>{facing=facing==='user'?'environment':'user';const running=active||starting;diag.event('Переключение камеры');if(running){const keepPaused=session.paused;camera.stop();begin({keepPaused});}else{session.restart('Смена камеры');buttons();updateDiag();}});
$('pose-model').addEventListener('change',()=>{diag.event(`Выбрана модель ${MODELS[modelKey()].name}`);if((active||starting)&&session.mode==='squat')begin({reuseCamera:true,keepPaused:session.paused});else updateDiag();});
$('show-points').addEventListener('change',()=>drawOverlay(overlay,lastLandmarks,session.mode,video.videoWidth||640,video.videoHeight||480,$('show-points').checked));
document.addEventListener('visibilitychange',()=>{if(document.hidden){releaseWakeLock();if(active||starting){session.pause();lastView={reason:'Приложение в фоне'};clearOverlay();diag.resetFps();renderState('Пауза','Вернувшись, нажмите «Продолжить» и займите исходное положение.');diag.event('Автоматическая пауза: приложение в фоне');buttons();updateDiag();}}else if(active&&!session.paused){requestWakeLock();}});
window.addEventListener('pagehide',()=>stop('Страница закрыта'));
$('diagnostics').addEventListener('toggle',updateDiag);
$('copy').addEventListener('click',async()=>{
  updateDiag();const field=$('copy-fallback');field.value=diag.reportText();$('select-report').disabled=false;
  $('copy').disabled=true;$('copy-status').textContent='Копируем отчёт…';
  try{
    const copied=await copyReport(field);
    $('copy-status').textContent=copied?'Отчёт скопирован целиком. Вставьте его в чат. Такой же текст показан ниже.':'Автокопирование недоступно. Нажмите и удерживайте текст ниже → «Выделить всё» → «Копировать».';
  }finally{$('copy').disabled=false;}
});
$('select-report').addEventListener('click',()=>{
  selectReport($('copy-fallback'));
  $('copy-status').textContent='Отчёт выделен целиком. Выберите «Копировать» в меню телефона и вставьте его в чат.';
});
$('download-diagnostics').addEventListener('click',()=>{
  updateDiag();const url=URL.createObjectURL(new Blob([diag.text()],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download=`exercise-counter-diagnostics-${new Date().toISOString().replaceAll(':','-')}.json`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
});

// PWA Install prompt handling for Android
let deferredInstallPrompt=null;
const pwaBtn=$('pwa-install-btn');
const isStandalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
if(isStandalone&&pwaBtn){
  pwaBtn.remove();
}else{
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredInstallPrompt=e;
    if(pwaBtn)pwaBtn.hidden=false;
  });
  window.addEventListener('appinstalled',()=>{
    deferredInstallPrompt=null;
    if(pwaBtn)pwaBtn.hidden=true;
    diag.event('Приложение установлено на Android');
  });
  if(pwaBtn){
    pwaBtn.addEventListener('click',async()=>{
      if(!deferredInstallPrompt)return;
      deferredInstallPrompt.prompt();
      const {outcome}=await deferredInstallPrompt.userChoice;
      if(outcome==='accepted'){
        pwaBtn.hidden=true;
        deferredInstallPrompt=null;
      }
    });
  }
}

renderMode(session.mode);renderCount(0);buttons();updateDiag();
