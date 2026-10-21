// Preparation is explicitly armed by a user gesture, independently of the
// exercise counter. All durations use monotonic milliseconds, never frames.
export const PREPARATION = Object.freeze({readyMs:2000,countdownMs:5000,glitchMs:220,maxSampleAgeMs:400});
export class RoundPreparation {
  constructor({now=()=>performance.now(),onChange=()=>{},onSignal=()=>{},onStart=async()=>false,autoTick=true}={}){
    Object.assign(this,{now,onChange,onSignal,onStart,autoTick});this.status='idle';this.generation=0;this.number=null;this.readyElapsed=0;this.lastSample=null;this.lastGood=null;this.badSince=null;this.previousGood=false;
  }
  get pending(){return ['loading','waiting','countdown','starting'].includes(this.status);}
  get state(){return {status:this.status,number:this.number,readyElapsed:this.readyElapsed};}
  emit(){this.onChange(this.state);}
  arm(){this.cancel();this.status='loading';this.resetEvidence();if(this.autoTick)this.timer=setInterval(()=>this.tick(),40);this.emit();return this.generation;}
  wait(generation){if(this.generation!==generation||this.status!=='loading')return false;this.status='waiting';this.resetEvidence();this.emit();return true;}
  resetEvidence(){this.number=null;this.readyElapsed=0;this.lastSample=null;this.lastGood=null;this.badSince=null;this.previousGood=false;this.deadline=null;}
  observe({poseReady,poseTimestamp}){
    // Once a start request has been authorized, pose changes cannot revoke it
    // while the network is responding. Explicit cancellation still can.
    if(!['waiting','countdown'].includes(this.status)||!Number.isFinite(poseTimestamp)||poseTimestamp===this.lastSample)return;
    const now=this.now();
    if(now-poseTimestamp>PREPARATION.maxSampleAgeMs||poseTimestamp>now+1)return;
    const previous=this.lastSample,gap=previous!==null&&poseTimestamp-previous>PREPARATION.maxSampleAgeMs;
    if(gap)this.backToWaiting();
    this.lastSample=poseTimestamp;
    if(poseReady){
      if(this.badSince!==null&&poseTimestamp-this.badSince>PREPARATION.glitchMs)this.backToWaiting();
      if(this.previousGood&&previous!==null&&!gap)this.readyElapsed+=Math.max(0,poseTimestamp-previous);
      this.lastGood=poseTimestamp;this.badSince=null;this.previousGood=true;
      if(this.status==='waiting'&&this.readyElapsed>=PREPARATION.readyMs){
        this.status='countdown';this.deadline=now+PREPARATION.countdownMs;this.number=5;this.onSignal('ready');this.onSignal('countdown',5);
      }
    }else{this.badSince??=poseTimestamp;this.previousGood=false;}
    this.tick();this.emit();
  }
  backToWaiting(){
    if(this.status==='starting')return;
    this.status='waiting';this.resetEvidence();
  }
  tick(){
    if(!['waiting','countdown'].includes(this.status))return;
    const now=this.now();
    if((this.lastGood!==null&&now-this.lastGood>PREPARATION.maxSampleAgeMs)||(this.badSince!==null&&now-this.badSince>PREPARATION.glitchMs)){
      this.backToWaiting();this.emit();return;
    }
    if(this.status!=='countdown')return;
    const n=Math.ceil(Math.max(0,this.deadline-now)/1000);
    if(n>0){if(n!==this.number){this.number=n;this.onSignal('countdown',n);this.emit();}return;}
    // Never send a start request using a missing/latest bad observation. A
    // brief bad frame may recover, but cannot authorize the actual start.
    if(!this.previousGood&&this.badSince!==null&&now-this.badSince<=PREPARATION.glitchMs)return;
    if(!this.previousGood||this.lastGood===null||now-this.lastGood>PREPARATION.maxSampleAgeMs){this.backToWaiting();this.emit();return;}
    this.status='starting';this.number=null;const generation=this.generation;this.emit();
    const isCurrent=()=>this.generation===generation&&this.status==='starting';
    Promise.resolve().then(()=>isCurrent()?this.onStart({isCurrent}):false).then(started=>{
      if(!isCurrent())return;
      this.status=started?'running':'error';clearInterval(this.timer);this.timer=null;
      if(started)this.onSignal('start');this.emit();
    }).catch(()=>{if(isCurrent()){this.status='error';clearInterval(this.timer);this.timer=null;this.emit();}});
  }
  fail(){this.cancel();this.status='error';this.emit();}
  complete(){const running=this.status==='running';this.cancel();this.status='completed';if(running)this.onSignal('end');this.emit();}
  cancel(){this.generation++;clearInterval(this.timer);this.timer=null;this.status='idle';this.resetEvidence();this.emit();}
}
