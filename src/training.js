import {Camera,cameraError} from './camera.js';
import {Vision} from './models.js';
import {ExerciseSession} from './session.js';
import {squatFeatures} from './algorithms/squat.js';
import {drawOverlay} from './overlay.js';
import {RoundClock} from './round-clock.js';
import {ROUND_MS,SETTLE_MS,SQUAT} from './config.js';
import {PREPARATION} from './round-preparation.js';

export class Training {
  constructor(video,canvas,callbacks={}){
    this.video=video;this.canvas=canvas;this.callbacks=callbacks;
    this.session=new ExerciseSession();this.clock=new RoundClock();
    this.facing='user';this.overlayVisible=true;this.mode='practice';this.roundStatus='idle';
    this.starting=false;this.active=false;this.run=0;this.lastFrame=-1;this.lastSent=-Infinity;
    this.capturing=false;this.frameCallback=null;this.lastLandmarks=[];this.fpsTimes=[];
    this.modelStatus='Не загружена';this.reason='Камера выключена';this.hint='Нажмите «Начать тренировку»';this.ready=false;this.poseReady=false;this.poseTimestamp=null;this.preparationLossAt=null;this.inferenceMs=0;
    this.camera=new Camera(video,()=>this.fail(new Error('Видеопоток прерван. Включите камеру повторно.')));
    this.vision=new Vision({onStatus:status=>{this.modelStatus=status;this.emit();},onError:error=>this.fail(error),onResult:data=>this.consume(data)});
    this.onVisibility=()=>{if(!document.hidden)return;if(this.mode!=='practice')this.abortRound('Приложение ушло в фон');else if(this.active||this.starting)this.pause();};
    this.onPageHide=()=>this.stopCamera('Страница закрыта');
    document.addEventListener('visibilitychange',this.onVisibility);
    window.addEventListener('pagehide',this.onPageHide);
  }
  get state(){
    const settings=this.camera.settings;
    return {cameraOn:!!this.camera.stream,starting:this.starting,modelStatus:this.modelStatus,
      cameraStatus:this.camera.stream?'Камера включена':'Камера выключена',hint:this.hint,reason:this.reason,
      ready:this.ready,poseReady:this.poseReady,poseTimestamp:this.poseTimestamp,count:this.session.count,paused:this.session.paused,phase:this.session.algorithm.phase,
      mode:this.mode,roundStatus:this.roundStatus,timerMs:this.clock.id?this.clock.remaining():ROUND_MS,
      fps:this.fpsTimes.length>1?Math.round((this.fpsTimes.length-1)*10000/(this.fpsTimes.at(-1)-this.fpsTimes[0]))/10:0,
      inferenceMs:this.inferenceMs,resolution:settings.width?`${settings.width} × ${settings.height} @ ${Math.round(settings.frameRate||0)} fps`:'—',
      facing:settings.facingMode||this.facing,overlayVisible:this.overlayVisible};
  }
  emit(){this.callbacks.onChange?.(this.state);}
  clearOverlay(){this.lastLandmarks=[];const ctx=this.canvas.getContext('2d');ctx.clearRect(0,0,this.canvas.width,this.canvas.height);}
  restart(reason){this.startPermit=null;this.startReference=null;this.lastPoseAt=null;this.poseTimestamp=null;this.poseReady=false;this.preparationLossAt=null;this.session.restart(reason);this.ready=false;this.reason=reason;this.lastFrame=-1;this.lastSent=-Infinity;this.fpsTimes=[];this.clearOverlay();}
  async prepare(){
    if(this.active&&this.camera.stream&&this.vision.ready){this.session.resume();this.restart('Встаньте прямо');this.emit();return true;}
    const generation=++this.run;this.starting=true;this.active=false;this.ready=false;this.session.resume();this.reason='Подготовка камеры и модели';this.hint='Разрешите доступ к камере и встаньте боком';this.emit();
    try{
      const [cameraReady,modelReady]=await Promise.all([this.camera.start(this.facing),this.vision.load('full')]);
      if(generation!==this.run||!cameraReady||!modelReady)return false;
      this.starting=false;this.active=true;this.restart('Встаньте в кадр');this.settleUntil=performance.now()+SETTLE_MS;
      this.hint='Займите исходное положение';
      if(document.hidden){if(this.mode==='practice')this.pause();else this.abortRound('Приложение ушло в фон');}
      this.emit();this.schedule();return true;
    }catch(error){if(generation===this.run)this.fail(error);return false;}
  }
  async startPractice(){
    const changedMode=this.mode!=='practice';
    this.abortRound('Выбрана обычная тренировка');this.mode='practice';this.roundStatus='idle';this.clock.clear();
    if(changedMode)this.session.reset();
    return this.prepare();
  }
  async prepareRound(kind='personal'){
    if(!['personal','competition'].includes(kind))throw new Error('Неизвестный режим раунда');
    this.abortRound('Подготовка нового раунда');this.mode=kind;this.roundStatus='preparing';this.clock.clear();this.session.reset();
    return this.prepare();
  }
  captureStartPermit(){
    if(!this.active||!this.ready||!this.poseReady||document.hidden||this.mode==='practice'||this.roundStatus!=='preparing'||this.lastPoseAt===null||this.clock.now()-this.lastPoseAt>SQUAT.maxGapMs)return null;
    this.startPermit=Object.freeze({epoch:this.session.epoch,mode:this.mode,reference:this.session.algorithm.standingReference()});
    return this.startPermit;
  }
  beginRound(round,permit=null){
    if(!this.active||document.hidden||this.mode==='practice'||this.roundStatus!=='preparing')return false;
    const authorized=permit&&permit===this.startPermit&&permit.epoch===this.session.epoch&&permit.mode===this.mode;
    if(permit&&!authorized)return false;
    if(!authorized&&(!this.ready||this.lastPoseAt===null||this.clock.now()-this.lastPoseAt>SQUAT.maxGapMs))return false;
    // Readiness was checked BEFORE requesting the server start. A delayed
    // response must not require a second pose confirmation to start the clock.
    // Movement recognition still resets and revalidates standing on a NEW frame.
    const standingReference=authorized?permit.reference:this.session.algorithm.standingReference();
    this.startPermit=null;
    this.clock.start(round);this.roundStatus='running';this.session.reset();this.restart('Начните из положения стоя');this.startReference=standingReference;this.hint='Встаньте прямо';
    clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),40);this.emit();return true;
  }
  tick(){
    if(this.roundStatus!=='running')return;
    if(document.hidden){this.abortRound('Приложение ушло в фон');return;}
    if(this.clock.tick()){
      this.roundStatus='completed';clearInterval(this.timer);this.timer=null;
      this.session.restart('Время вышло');this.ready=false;this.reason='Время вышло';this.hint='Сохраняем результат';this.emit();
      this.callbacks.onRoundEnd?.({id:this.clock.id,status:'completed',count:this.session.count,reason:'Минута завершена'});
    }else this.emit();
  }
  abortRound(reason='Раунд завершён досрочно'){
    const running=this.roundStatus==='running',preparing=this.roundStatus==='preparing';
    if(!running&&!preparing)return;
    this.clock.abort();clearInterval(this.timer);this.timer=null;this.roundStatus='interrupted';this.session.restart(reason);this.ready=false;this.reason=reason;this.hint='Попытка прервана';this.emit();
    if(running)this.callbacks.onRoundEnd?.({id:this.clock.id,status:'interrupted',count:this.session.count,reason});
  }
  pause(){
    if(this.mode!=='practice'){this.abortRound('В минутном раунде пауза недоступна');return;}
    this.session.pause();this.ready=false;this.reason='Пауза';this.hint='Нажмите «Продолжить» и встаньте прямо';this.clearOverlay();this.emit();
  }
  resume(){if(this.mode!=='practice')return;this.session.resume();this.restart('После паузы встаньте прямо');this.hint='Встаньте прямо';this.emit();}
  reset(){if(this.mode!=='practice')return;this.session.reset();this.restart('Счётчик подхода сброшен');this.hint='Встаньте прямо';this.emit();}
  async switchCamera(){
    const wasActive=this.active||this.starting,paused=this.session.paused;
    this.abortRound('Камера переключена');this.facing=this.facing==='user'?'environment':'user';
    this.stopCamera('Камера переключена');
    if(wasActive){const ok=await this.prepare();if(paused&&this.mode==='practice')this.pause();return ok;}
    this.emit();return false;
  }
  setOverlay(visible){this.overlayVisible=!!visible;this.paint(this.lastLandmarks);this.emit();}
  stopCamera(reason='Камера выключена'){
    this.abortRound(reason);this.run++;this.active=false;this.starting=false;this.cancelFrame();this.vision.close();this.camera.stop();
    this.restart(reason);this.modelStatus='Не загружена';this.hint='Включите камеру, когда будете готовы';this.emit();
  }
  fail(error){
    const message=cameraError(error);this.stopCamera(message);this.modelStatus='Ошибка загрузки / обработки';this.reason=message;this.hint=message;this.emit();this.callbacks.onError?.(error);
  }
  schedule(){
    if(!this.active||this.frameCallback!==null)return;
    if(this.video.requestVideoFrameCallback){this.frameKind='video';this.frameCallback=this.video.requestVideoFrameCallback((now,metadata)=>this.frame(now,metadata));}
    else{this.frameKind='animation';this.frameCallback=requestAnimationFrame(now=>this.frame(now));}
  }
  cancelFrame(){if(this.frameCallback===null)return;if(this.frameKind==='video')this.video.cancelVideoFrameCallback(this.frameCallback);else cancelAnimationFrame(this.frameCallback);this.frameCallback=null;}
  async frame(now,metadata){
    this.frameCallback=null;this.schedule();
    if(!this.active||this.starting||this.session.paused||document.hidden||!this.vision.ready||this.vision.busy||this.capturing||this.video.readyState<2)return;
    if(this.roundStatus==='running'&&this.clock.remaining()<=0){this.tick();return;}
    const mediaTime=metadata?.mediaTime??this.video.currentTime;
    // Capture each new frame at most once, with no pending-frame queue.
    if(mediaTime===this.lastFrame||now-this.lastSent<1000/20)return;
    this.lastFrame=mediaTime;this.capturing=true;const epoch=this.session.epoch;
    try{
      const bitmap=await createImageBitmap(this.video);
      if(!this.active||this.session.paused||document.hidden||epoch!==this.session.epoch){bitmap.close();return;}
      this.lastSent=now;this.vision.detect(bitmap,now,epoch);
    }catch(error){if(this.active&&epoch===this.session.epoch)this.fail(new Error('Не удалось обработать кадр камеры'));}
    finally{this.capturing=false;}
  }
  paint(landmarks){
    this.lastLandmarks=landmarks;drawOverlay(this.canvas,landmarks,this.video.videoWidth||640,this.video.videoHeight||480,this.overlayVisible);
  }
  consume(data){
    if(!this.active||this.session.paused||document.hidden||data.epoch!==this.session.epoch)return;
    this.paint(data.landmarks);this.inferenceMs=Math.round(data.ms);this.fpsTimes.push(data.timestamp);this.fpsTimes=this.fpsTimes.filter(time=>data.timestamp-time<2000);
    if(this.roundStatus==='running'&&!this.clock.accepts(data.timestamp)){this.tick();return;}
    if(this.mode!=='practice'&&['completed','interrupted','idle'].includes(this.roundStatus))return;
    if(data.timestamp<(this.settleUntil||0)){this.reason='Встаньте в кадр';this.hint='Займите исходное положение';this.ready=false;this.emit();return;}
    const features=squatFeatures(data.landmarks[0],this.video.videoWidth,this.video.videoHeight,this.session.algorithm.side);
    this.poseTimestamp=data.timestamp;this.poseReady=!!features.valid&&features.upright&&features.angle>=SQUAT.standAngle;
    if(this.roundStatus==='preparing'&&!features.valid){
      // Preparation alone filters an isolated detection miss; an active round
      // still discards its incomplete movement immediately on tracking loss.
      this.preparationLossAt??=data.timestamp;
      if(data.timestamp-this.preparationLossAt<=PREPARATION.glitchMs){this.ready=false;this.reason=features.reason;this.hint=features.reason;this.emit();return;}
    }else this.preparationLossAt=null;
    if(this.roundStatus==='running'&&this.startReference){
      this.session.algorithm.confirmStandingAtStart(this.startReference,features);this.startReference=null;
    }
    this.lastPoseAt=data.timestamp;
    const view=this.session.update(features,data.timestamp,data.epoch);if(!view)return;
    this.ready=!!view.tracking&&view.phase==='standing';
    this.poseReady=this.poseReady&&this.ready;
    this.reason=view.tracking?(view.ready?'Идёт подсчёт':'Встаньте прямо'):features.reason;
    this.hint=view.tracking?view.hint:features.reason;
    if(this.mode!=='practice'&&this.roundStatus==='preparing'){
      // Preparation may observe movement but never accrues repetitions.
      this.session.count=0;
      if(this.ready){this.reason='Положение определяется';this.hint='Встаньте в кадр в исходное положение. Отсчёт начнётся автоматически';}
    }else if(view.increment){
      this.callbacks.onRepetition?.({occurredAt:new Date().toISOString(),roundId:this.roundStatus==='running'?this.clock.id:null,
        elapsedMs:this.roundStatus==='running'?Math.floor(this.clock.elapsed(data.timestamp)):null});
    }
    this.emit();
  }
  destroy(){this.stopCamera();document.removeEventListener('visibilitychange',this.onVisibility);window.removeEventListener('pagehide',this.onPageHide);}
}
