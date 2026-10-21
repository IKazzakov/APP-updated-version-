import {VERSION,VISION_VERSION} from './config.js';
const short=(value,limit=180)=>value==null?null:String(value).slice(0,limit);
const rounded=value=>Number.isFinite(value)?Math.round(value*10)/10:null;
function statistics(rows){
  if(!rows.length)return null;
  const recent=rows.filter(r=>rows.at(-1).t-r.t<=2000);
  const times=recent.filter(r=>r.hands===2&&Number.isFinite(r.inferenceMs)).map(r=>r.inferenceMs).sort((a,b)=>a-b);
  const duration=recent.at(-1).t-recent[0].t;
  return {frames:recent.length,windowMs:duration,
    processingFps:duration>0?rounded((recent.length-1)*1000/duration):null,
    twoHands:recent.filter(r=>r.hands===2).length,oneHand:recent.filter(r=>r.hands===1).length,
    noHands:recent.filter(r=>r.hands===0).length,validFrames:recent.filter(r=>r.valid).length,
    twoHandsMsMedian:times.length?rounded((times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2):null,
    twoHandsMsP95:times.length?rounded(times[Math.ceil(times.length*.95)-1]):null};
}
function attemptSummary(a){
  if(!a)return null;
  const keys=['id','status','durationMs','closeObserved','minimumRatio','minimumDistancePx','referenceScalePx','referenceRatio','strokePeakRatio','closeThreshold','returnThreshold','maxGapMs','missingFrames'];
  return {...Object.fromEntries(keys.map(k=>[k,a[k]??null])),reason:short(a.reason)};
}
export class Diagnostics {
  constructor(){this.log=[];this.errors=[];this.fps=0;this.frames=[];this.motionHistory=[];this.values={};this.trackingHistory=[];this.rejections={};this.lastTrackingState=null;this.attempts=[];this.currentAttempt=null;this.lastWithTwoHands=null;this.lastTwoHandsAt=null;this.savedTwoHandsWindow=null;this.lastGoodMotion=null;this.lastGoodOptical=null;}
  event(message){this.log.push({time:new Date().toISOString(),message});this.log=this.log.slice(-80);}
  error(error){const message=error?.message||String(error);this.errors.push({time:new Date().toISOString(),message});this.errors=this.errors.slice(-12);this.event(message);}
  frame(t){this.frames.push(t);this.frames=this.frames.filter(n=>t-n<2000);this.fps=this.frames.length>1?1000*(this.frames.length-1)/(t-this.frames[0]):0;}
  resetFps(){this.frames=[];this.fps=0;}
  syncClap(counter){this.attempts=counter.attempts.slice();this.currentAttempt=counter.currentAttempt;}
  observeMotion(data,features,view){
    const sample={t:Math.round(data.timestamp),ms:rounded(data.ms),hands:data.landmarks.length,valid:features.valid,
      phase:view.phase,reason:view.reason,ratio:rounded(features.ratio),increment:view.increment||0,
      confidence:rounded(data.confidence),anchorAgeMs:rounded(data.anchorAgeMs),source:data.source??'optical',fusionDelayMs:rounded(data.fusionDelayMs)};
    this.motionHistory.push(sample);this.motionHistory=this.motionHistory.slice(-180);
    const recent=this.motionHistory.filter(r=>data.timestamp-r.t<2000),span=recent.at(-1).t-recent[0].t;
    this.values.motion={fps:span>0?rounded((recent.length-1)*1000/span):0,ms:sample.ms,
      input:`${data.inputWidth} × ${data.inputHeight}`,hands:sample.hands,confidence:sample.confidence,anchorAgeMs:sample.anchorAgeMs,
      validFrames:recent.filter(r=>r.valid).length,opticalValidFrames:recent.filter(r=>r.valid&&r.source==='optical').length,modelRepairedFrames:recent.filter(r=>r.valid&&r.source==='model-anchor').length,frames:recent.length,source:sample.source,fusionDelayMs:sample.fusionDelayMs};
    if(features.valid)this.lastGoodMotion={...this.values.motion,at:new Date().toISOString()};
    if(features.valid&&sample.source==='optical')this.lastGoodOptical={...this.values.motion,at:new Date().toISOString()};
  }
  observeHands(data,features,view){
    const round=v=>Number.isFinite(v)?Math.round(v*1000)/1000:null;
    const sample={t:Math.round(data.timestamp),hands:data.landmarks.length,inferenceMs:rounded(data.ms),valid:features.valid,partialHands:features.partialHands??0,phase:view.phase,reason:view.reason,featureReason:features.valid?null:features.reason,suspended:view.suspended??false,ratio:features.valid?round(view.metrics?.palmDistance):null,rawRatio:features.valid?round(features.ratio):null,distancePx:round(features.distancePx),scale:round(features.scale),referenceScale:round(view.metrics?.referenceScale),referenceRatio:round(view.metrics?.referenceRatio),threshold:view.metrics?.closeThreshold??null,returnThreshold:view.metrics?.returnThreshold??null,periodMs:view.metrics?.periodMs??null,increment:view.increment||0};
    // Preserve the preceding useful window only when hands disappear. Avoid
    // sorting/copying a frame window on every inference in the performance path.
    if(sample.hands!==2&&this.lastWithTwoHands&&!this.savedTwoHandsWindow)this.savedTwoHandsWindow=this.trackingHistory.slice();
    this.trackingHistory.push(sample);this.trackingHistory=this.trackingHistory.slice(-180);
    if(sample.hands===2){
      this.lastTwoHandsAt=Date.now();this.savedTwoHandsWindow=null;
      this.lastWithTwoHands={at:new Date(this.lastTwoHandsAt).toISOString(),fps:rounded(this.fps),inferenceMs:sample.inferenceMs,
        delegate:data.delegate??this.values.delegate??null,valid:sample.valid,phase:sample.phase,featureReason:sample.featureReason};
    }
    this.values.handsDetected=sample.hands;this.values.featureReason=sample.featureReason;
    this.values.handednessScores=data.scores;
    if(!features.valid){this.rejections[features.code]=(this.rejections[features.code]||0)+1;this.values.lastRejection={time:new Date().toISOString(),reason:features.reason};}
    const state=JSON.stringify([sample.phase,sample.featureReason]);
    if(state!==this.lastTrackingState){this.event(`Хлопки: ${sample.hands} кистей; ${sample.phase}; ${sample.featureReason||sample.reason}`);this.lastTrackingState=state;}
  }
  snapshot(){return {app:'Счётчик упражнений',version:VERSION,vision:VISION_VERSION,browser:navigator.userAgent,secureContext:isSecureContext,...this.values,fps:Math.round(this.fps*10)/10,attempts:this.attempts,currentAttempt:this.currentAttempt,errors:this.errors,log:this.log,rejections:this.rejections,trackingHistory:this.trackingHistory,
    lastWithTwoHands:this.lastWithTwoHands?{...this.lastWithTwoHands,ageMs:Math.max(0,Date.now()-this.lastTwoHandsAt)}:null,
    lastTwoHandsTrackingHistory:this.savedTwoHandsWindow,motionHistory:this.motionHistory,lastGoodMotion:this.lastGoodMotion,lastGoodOptical:this.lastGoodOptical};}
  text(){return JSON.stringify(this.snapshot(),null,2);}
  report(){
    const d=this.snapshot();
    const transitions=d.trackingHistory.filter((r,i,a)=>i===0||r.phase!==a[i-1].phase||r.hands!==a[i-1].hands||r.featureReason!==a[i-1].featureReason||r.increment);
    return {app:d.app,version:d.version,report:'support-v1',createdAt:new Date().toISOString(),
      resolution:d.resolution??null,modelInput:d.modelInput??null,fps:d.fps,inferenceMs:d.inferenceMs??null,
      cameraDeliveredFps:d.cameraDeliveredFps??null,trackingSource:d.trackingSource??null,
      autoProfile:d.autoProfile??null,motion:d.motion??null,motionAnchor:d.motionAnchor??null,lastGoodMotion:d.lastGoodMotion,lastGoodOptical:d.lastGoodOptical,motionFallback:short(d.motionFallback),
      delegate:d.delegate??null,backendStatus:d.backendStatus??null,backendBenchmark:d.backendBenchmark??null,fallbackReason:short(d.fallbackReason),
      exercise:d.exercise??null,model:d.model??null,modelStatus:d.modelStatus??null,camera:d.camera??null,
      secureContext:d.secureContext,browser:short(d.browser,260),vision:d.vision,
      count:d.count??0,counts:d.counts??null,phase:d.phase??null,reason:short(d.reason),paused:d.paused??false,
      handsDetected:d.handsDetected??null,featureReason:short(d.featureReason),
      recent:statistics(this.trackingHistory),
      lastWithTwoHands:this.lastWithTwoHands?{...d.lastWithTwoHands,
        recent:statistics(this.savedTwoHandsWindow??this.trackingHistory)}:null,
      attempts:this.attempts.slice(-3).map(attemptSummary),currentAttempt:attemptSummary(this.currentAttempt),
      rejections:{...this.rejections},errors:this.errors.slice(-2).map(e=>({...e,message:short(e.message)})),
      trackingHistory:transitions.slice(-4).map(r=>({t:r.t,hands:r.hands,valid:r.valid,phase:r.phase,
        reason:short(r.featureReason||r.reason,120),ratio:r.ratio,increment:r.increment})),
      log:this.log.slice(-2).map(e=>({...e,message:short(e.message)}))};
  }
  reportText(){
    // One top-level field per line, compact nested summaries. No huge raw frame
    // array: the report remains practical to paste from a phone into the chat.
    return '{\n'+Object.entries(this.report()).map(([k,v])=>'  '+JSON.stringify(k)+': '+JSON.stringify(v)).join(',\n')+'\n}';
  }
}
