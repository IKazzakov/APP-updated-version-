import {CLAP as C} from '../config.js';
import {distance,Smoother} from './geometry.js';
export {clapFeatures} from './clap-features.js';
const median=values=>{const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
const rounded=v=>Number.isFinite(v)?Math.round(v*1000)/1000:null;

export class ClapCounter {
  constructor(){
    this.smooth=new Smoother(C.smoothMs);this.attempts=[];this.attemptId=0;
    this.attempt=null;this.lastInputTime=null;this.cadenceMs=84;this.reset();
  }
  reset(reason='Разведите ладони'){
    this.finishAttempt('cancelled',reason,this.lastInputTime);
    this.phase='baseline';this.reason=reason;this.reference=null;this.previous=null;
    this.last=null;this.missingAt=null;this.openAt=null;this.reopenAt=null;
    this.samples=[];this.refreshAllowed=false;this.minimum=null;this.minimumAt=null;this.startedAt=null;
    this.peak=null;this.lastCountAt=null;this.lastCountMinimumAt=null;this.periods=[];
    this.suspended=false;this.smooth.reset();
    this.recovery=null;
    this.reacquiring=false;this.reacquireSamples=[];
  }
  get gapBudget(){
    const sampling=Math.min(C.gapMaxMs,Math.max(C.gapMinMs,this.cadenceMs*C.gapFrames+C.gapPaddingMs));
    return this.periods.length?Math.min(sampling,Math.max(C.rhythmGapMinMs,median(this.periods)*C.gapPeriodFraction)):sampling;
  }
  get closeLimit(){return this.reference?Math.min(C.close,(this.peak??this.reference.ratio)*C.closeFraction):C.close;}
  get returnLimit(){
    // A fast, smaller stroke need not return to the original wide calibration.
    // Require a substantial fraction of THIS observed stroke, bounded above
    // and below to separate a true outward movement from endpoint tremor.
    const minimum=this.minimum??C.close;
    const rise=Math.max(C.reopenRise,Math.min(C.maxReopenRise,((this.peak??C.open)-minimum)*C.reopenFraction));
    return Math.max(C.minReopenRatio,minimum+rise);
  }
  get currentAttempt(){
    if(!this.attempt)return null;
    const {events,...rest}=this.attempt;
    return {...rest,events:events.map(e=>({...e}))};
  }
  attemptEvent(type,t,extra={}){
    if(!this.attempt)return;
    this.attempt.events.push({t:Math.round(t),type,...extra});
    this.attempt.events=this.attempt.events.slice(-C.attemptEventLimit);
  }
  startAttempt(t){
    this.attempt={id:++this.attemptId,status:'pending',startedAt:Math.round(t),
      referenceScalePx:rounded(this.reference.scale),referenceDistancePx:rounded(this.reference.distance),
      referenceRatio:rounded(this.reference.ratio),closeThreshold:rounded(this.closeLimit),
      strokePeakRatio:rounded(this.peak),returnThreshold:rounded(this.returnLimit),minimumRatio:null,minimumDistancePx:null,
      closeObserved:false,observedFrames:0,missingFrames:0,interruptions:0,maxGapMs:0,events:[]};
    this.attemptEvent('approaching',t);
  }
  finishAttempt(status,reason,t){
    if(!this.attempt)return;
    this.attemptEvent(status,t??this.lastInputTime??this.attempt.startedAt,{reason});
    this.attempt.status=status;this.attempt.reason=reason;
    this.attempt.endedAt=Math.round(t??this.lastInputTime??this.attempt.startedAt);
    this.attempt.durationMs=this.attempt.endedAt-this.attempt.startedAt;
    this.attempts.push(this.currentAttempt);this.attempts=this.attempts.slice(-C.attemptLimit);this.attempt=null;
  }
  reject(reason,t,recover=false){
    const reference=recover?(this.reference??this.recovery?.reference):null;
    const lastValid=this.last??this.recovery?.lastValid;
    const reacquire=recover&&!!(reference||this.reacquiring);
    this.finishAttempt('rejected',reason,t);this.reset(reason);
    // Discard the ENTIRE unfinished cycle, but a brief image dropout need not
    // discard a still-recent palm scale. Two fresh separated-hand observations
    // can confirm a new start while the hands keep moving. No old close/peak,
    // increment or predicted rhythm survives this rearming path.
    if(reference&&lastValid!==null&&t-lastValid<=C.maxGapMs)this.recovery={reference,lastValid,first:null};
    this.reacquiring=reacquire;
  }
  beginReacquire(reason){this.reset(reason);this.reacquiring=true;}
  movingBaseline(f,t){
    // Old scale/close/peak are not reused here. Two new full-palm observations
    // must be separated, agree on depth/size and follow a plausible trajectory.
    // Returning to the frame only ARMS the next cycle; it never increments.
    if(f.partialHands||f.distancePx/f.scale<C.open){this.reacquireSamples=[];return false;}
    const prior=this.reacquireSamples.at(-1);
    if(prior){
      const scaleRatio=f.scale/prior.scale;
      if(t-prior.t>C.reacquireWindowMs||Math.abs(scaleRatio-1)>C.reacquireScaleChange){this.reacquireSamples=[];}
      else if(prior.centres&&f.centres){
        const [a,b]=prior.centres,[x,y]=f.centres;
        const shift=Math.min(Math.max(distance(a,x),distance(b,y)),Math.max(distance(a,y),distance(b,x)));
        if(shift/prior.scale>C.positionSlack+C.maxPalmSpeed*(t-prior.t)/1000)this.reacquireSamples=[];
      }
    }
    this.reacquireSamples.push({t,scale:f.scale,distancePx:f.distancePx,centres:f.centres});
    this.reacquireSamples=this.reacquireSamples.filter(s=>t-s.t<=C.reacquireWindowMs).slice(-8);
    if(this.reacquireSamples.length<2||t-this.reacquireSamples[0].t<C.reacquireMs)return false;
    this.reference={scale:median(this.reacquireSamples.map(s=>s.scale)),distance:f.distancePx};
    this.reference.ratio=f.distancePx/this.reference.scale;this.peak=this.reference.ratio;
    this.phase='open';this.reason='Новое разведение подтверждено в движении';
    this.smooth.reset();this.smooth.next(this.peak,t);this.reacquiring=false;this.reacquireSamples=[];this.samples=[];
    return true;
  }
  view(extra={}){
    const hint=this.phase==='baseline'?'Покажите обе руки и разведите ладони':this.phase==='open'?'Сведите ладони перед грудью':this.phase==='approaching'?'Продолжайте сближать ладони':'Разведите ладони';
    return {phase:this.phase,reason:this.reason,ready:this.phase!=='baseline',tracking:true,
      suspended:this.suspended,hint,increment:0,
      metrics:{palmDistance:this.smooth.value,minimumDistance:this.minimum,
        closeThreshold:this.closeLimit,returnThreshold:this.returnLimit,
        referenceScale:this.reference?.scale??null,referenceDistance:this.reference?.distance??null,
        referenceRatio:this.reference?.ratio??null,strokePeakRatio:this.peak,
        periodMs:this.periods.length?Math.round(median(this.periods)):null,gapBudgetMs:Math.round(this.gapBudget)},...extra};
  }
  calibrate(f,t,refresh=false){
    // Edge observations may continue a trajectory, but cannot set its scale.
    if(f.partialHands){this.samples=[];this.reacquireSamples=[];this.reason='Для подготовки покажите обе ладони целиком';return false;}
    const rawRatio=f.distancePx/f.scale;
    if(this.recovery){
      const r=this.recovery;
      if(t-r.lastValid>C.maxGapMs)this.recovery=null;
      else{
        const separated=f.distancePx/r.reference.scale>=C.open;
        if(!separated){r.first=null;return false;}
        r.first??=t;
        if(t-r.first<16)return false;
        this.reference=r.reference;this.peak=f.distancePx/this.reference.scale;
        this.phase='open';this.reason='Новое разведение подтверждено после пропуска';
        this.smooth.reset();this.smooth.next(this.peak,t);this.recovery=null;this.samples=[];
        this.reacquiring=false;
        return true;
      }
    }
    if(this.reacquiring)return this.movingBaseline(f,t);
    if(rawRatio<C.open){this.samples=[];return false;}
    const referenceScale=this.samples.length?median(this.samples.map(s=>s.scale)):f.scale;
    const distances=[...this.samples.map(s=>s.distancePx),f.distancePx];
    // No moving reference during approach: a bounded stable window is captured
    // once, then completely locked. Refresh is allowed only AFTER a full return.
    if(Math.max(...distances)-Math.min(...distances)>C.baselineJitter*referenceScale)this.samples=[];
    this.samples.push({t,distancePx:f.distancePx,scale:f.scale});
    this.samples=this.samples.filter(s=>t-s.t<=C.baselineMs+this.cadenceMs*2).slice(-30);
    if(this.samples.length<3||t-this.samples[0].t<C.baselineMs)return false;
    this.reference={scale:median(this.samples.map(s=>s.scale)),distance:median(this.samples.map(s=>s.distancePx))};
    this.reference.ratio=this.reference.distance/this.reference.scale;
    this.peak=this.reference.ratio;
    this.phase='open';this.reason=refresh?'Исходное положение обновлено':'Ладони разведены';
    this.smooth.reset();this.smooth.next(f.distancePx/this.reference.scale,t);
    this.samples=[];this.refreshAllowed=false;return true;
  }
  continuous(f,t,recovering){
    if(f.oneHandCenter||(f.singleHand&&(f.isCenter??true)))return true;
    if(!this.previous?.centres||!f.centres)return true;
    const [a,b]=this.previous.centres,[x,y]=f.centres;
    const direct=[distance(a,x),distance(b,y)],swapped=[distance(a,y),distance(b,x)];
    const best=direct[0]+direct[1]<=swapped[0]+swapped[1]?direct:swapped;
    const allowance=C.positionSlack+C.maxPalmSpeed*(t-this.last)/1000;
    if(Math.max(...best)/this.reference.scale>allowance)return false;
    return !recovering||f.distancePx/this.reference.scale<=this.reference.ratio*C.maxReturnExpansion;
  }
  update(input,t){
    if(!Number.isFinite(t))return this.view({tracking:false,reason:'Нет временной метки кадра'});
    const packetGap=this.lastInputTime===null?null:t-this.lastInputTime;
    if(packetGap!==null&&packetGap>0&&packetGap<=C.maxGapMs)this.cadenceMs=0.8*this.cadenceMs+0.2*packetGap;
    if(packetGap!==null&&packetGap<=0)return this.view({tracking:false,reason:'Устаревший кадр пропущен'});
    this.lastInputTime=t;
    if(this.startedAt!==null&&t-this.startedAt>C.maxCycleMs){this.reject('Движение затянулось: снова разведите ладони',t);return this.view();}
    const isOneHandContact = (this.phase === 'approaching' || this.phase === 'closed') && (
      Boolean(input?.oneHandCenter) ||
      Boolean(input?.singleHand && (input.isCenter ?? true)) ||
      Boolean(input?.handCount === 1 && (input.isCenter ?? true))
    );
    if(!input?.valid && !isOneHandContact){
      const reason=input?.reason||'Покажите обе руки';
      if(this.phase==='baseline'){
        const evidence=this.reacquireSamples.at(-1)?.t??this.samples.at(-1)?.t??(this.recovery?.first!=null?this.last:null);
        if(evidence!=null&&t-evidence<=C.baselineGapMs){
          return this.view({tracking:false,reason,hint:'Ожидаем следующее наблюдение обеих кистей'});
        }
      }
      if(this.attempt){this.attempt.missingFrames++;this.attempt.maxGapMs=Math.max(this.attempt.maxGapMs,Math.round(t-this.last));}
      if(this.reference&&this.last!==null&&t-this.last<=this.gapBudget){
        if(!this.suspended){this.attemptEvent('tracking_lost',t,{reason,budgetMs:Math.round(this.gapBudget)});if(this.attempt)this.attempt.interruptions++;}
        this.suspended=true;this.missingAt??=t;this.reopenAt=null;this.samples=[];
        return this.view({tracking:false,reason,hint:'Покажите обе руки — движение приостановлено'});
      }
      this.reject(this.reference?'Кисти потеряны надолго: '+reason:reason,t,true);
      return this.view({tracking:false,hint:reason});
    }
    // ratio-only features are accepted by the pure algorithm tests. Runtime
    // always supplies distancePx, so projected palm width cannot alter a cycle.
    const scale=input.scale??this.reference?.scale??1;
    const distancePx=isOneHandContact?0:(input.distancePx??input.ratio*scale);
    const f={...input,scale,distancePx,valid:true,centres:input.centres??(input.centre?[input.centre,input.centre]:this.previous?.centres)};
    if(!Number.isFinite(f.distancePx)||f.distancePx<0||!Number.isFinite(scale)||scale<=0){
      this.reject('Некорректная геометрия кистей',t);return this.view({tracking:false});
    }
    if(this.attempt&&this.suspended)this.attempt.maxGapMs=Math.max(this.attempt.maxGapMs,Math.round(t-this.last));
    if(this.last!==null&&(t-this.last>C.maxGapMs||this.suspended&&t-this.last>this.gapBudget)){
      this.reject('Не удалось восстановить движение после потери кистей',t,true);
    }
    const recovering=this.suspended;
    if(this.reference&&!this.continuous(f,t,recovering))this.reject('Траектория кистей резко изменилась: снова разведите ладони',t);
    if(this.suspended){
      const gap=t-this.last;this.attemptEvent('tracking_restored',t,{gapMs:Math.round(gap)});
      if(this.attempt)this.attempt.maxGapMs=Math.max(this.attempt.maxGapMs,Math.round(gap));
    }
    const prior=this.previous;
    this.suspended=false;this.missingAt=null;
    if(this.phase==='baseline'){
      this.calibrate(f,t);this.last=t;this.previous={time:t,distancePx:f.distancePx,centres:f.centres,ratio:this.smooth.value};
      return this.view();
    }
    const ratio=isOneHandContact?0:this.smooth.next(f.distancePx/this.reference.scale,t);
    if(isOneHandContact){this.smooth.reset();this.smooth.next(0,t);}
    const previousRatio=prior?.ratio??(prior?prior.distancePx/this.reference.scale:ratio);
    if(this.attempt){
      this.attempt.observedFrames++;
      this.attempt.minimumDistancePx=Math.min(this.attempt.minimumDistancePx??Infinity,rounded(f.distancePx));
      if(this.minimum===null||ratio<this.minimum){this.minimum=ratio;this.minimumAt=t;this.attempt.minimumRatio=rounded(ratio);}
      this.attempt.returnThreshold=rounded(this.returnLimit);
    }
    let increment=0;
    if(this.phase==='open'){
      // Follow the actual local peak; either or both palms may move. Only this
      // stroke uses the peak. The distance-normalizing palm scale stays fixed.
      this.peak=Math.max(this.peak??ratio,ratio);
      const speed=Math.abs(ratio-previousRatio)/Math.max(0.001,(t-(prior?.time??t))/1000);
      const refreshing=this.refreshAllowed&&ratio>=this.returnLimit&&f.distancePx/f.scale>=C.open&&speed<=C.stableSpeed;
      if(refreshing)this.calibrate(f,t,true);
      else if(this.peak-ratio>=C.approachDrop){
        this.phase='approaching';this.reason='Ладони сближаются';this.startedAt=prior?.time??t;
        this.samples=[];this.refreshAllowed=false;this.minimum=ratio;this.minimumAt=t;this.startAttempt(this.startedAt);
        this.attempt.observedFrames=1;this.attempt.minimumRatio=rounded(ratio);this.attempt.minimumDistancePx=rounded(f.distancePx);
      }else this.samples=[];
    }
    if(this.phase==='approaching'){
      const contracted=this.peak-ratio>=C.minContraction;
      if((contracted&&ratio<=this.closeLimit)||isOneHandContact){
        this.phase='closed';this.reason='Близкое положение двух ладоней наблюдалось';
        this.attempt.closeObserved=true;this.attemptEvent('close_observed',t,{ratio:rounded(ratio),overlap:isOneHandContact});
      }else if(ratio-this.minimum>=C.directionRise&&ratio>previousRatio){
        // An incomplete approach is rejected on a real reversal. Previously
        // its return gate could exceed its own starting peak and trap the FSM.
        this.finishAttempt('rejected','Недостаточное сближение ладоней',t);
        this.phase='open';this.reason='Неполное сближение: повторите движение';this.startedAt=null;this.minimum=null;this.peak=ratio;this.refreshAllowed=true;
      }
    }else if(this.phase==='closed'||this.phase==='reopening'){
      const outward=ratio-this.minimum>=C.directionRise&&ratio>previousRatio;
      if(this.phase==='closed'&&outward){this.phase='reopening';this.reason='Ладони снова расходятся';this.attemptEvent('reopening',t,{ratio:rounded(ratio)});}
      if(this.phase==='reopening'){
        if(ratio<this.minimum+C.directionRise/2){this.phase='closed';this.reopenAt=null;}
        else if(outward&&ratio>=this.returnLimit){
          // No timer/second endpoint frame: amplitude plus a real reversal are
          // the evidence. Neither holding together nor disappearance counts.
          // A brief occlusion may delay the PREVIOUS completion. Measure the
          // refractory interval between observed minima, not delayed returns,
          // otherwise a valid next clap is rejected for catching up too soon.
          const duration=t-this.startedAt,interval=this.lastCountMinimumAt===null?Infinity:this.minimumAt-this.lastCountMinimumAt;
          increment=duration>=C.minCycleMs&&interval>=C.minRepeatMs?1:0;
          const reason=increment?'Повторение засчитано':'Слишком быстрое колебание: цикл отклонён';
          if(increment){
            if(Number.isFinite(interval)&&interval<=2000)this.periods=[...this.periods,interval].slice(-5);
            this.lastCountAt=t;
            this.lastCountMinimumAt=this.minimumAt;
          }
          this.finishAttempt(increment?'counted':'rejected',reason,t);
          this.phase='open';this.reason=reason;this.startedAt=null;this.reopenAt=null;this.minimum=null;this.peak=ratio;
          this.refreshAllowed=true;this.samples=[];
        }
      }
    }
    this.last=t;this.previous={time:t,distancePx:f.distancePx,centres:f.centres,ratio};
    return this.view({increment});
  }
}
