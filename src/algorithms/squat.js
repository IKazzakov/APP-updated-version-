import {SQUAT as C} from '../config.js';
import {angle,pixel,distance,Smoother,stable} from './geometry.js';
export class SquatCounter {
  constructor(){this.knee=new Smoother(C.smoothMs);this.height=new Smoother(C.smoothMs);this.reset();}
  reset(reason='Подтвердите положение стоя'){
    this.phase='baseline';this.reason=reason;this.side=null;this.last=null;
    this.baseHeight=null;this.baseLeg=null;this.candidate=null;this.downAt=null;
    this.standAt=null;this.bottomAt=null;this.returnAt=null;this.knee.reset();this.height.reset();
  }
  standingReference(){return this.phase==='standing'?{side:this.side,baseHeight:this.baseHeight,baseLeg:this.baseLeg}:null;}
  confirmStandingAtStart(reference,f){
    // A timed start may reuse the already calibrated body scale, never an old
    // movement. The FIRST observed frame inside the round must still be
    // standing. A crouched/missing first frame keeps normal baseline recovery.
    if(!reference||!f?.valid||f.side!==reference.side||!f.upright||f.angle<C.standAngle||
      ![reference.baseHeight,reference.baseLeg,f.height,f.leg].every(Number.isFinite)||reference.baseLeg<=0||f.leg<=0||
      Math.abs(reference.baseHeight/reference.baseLeg-f.height/f.leg)>=C.returnDrop)return false;
    this.phase='standing';this.side=reference.side;this.baseHeight=reference.baseHeight;this.baseLeg=reference.baseLeg;
    this.reason='Исходное положение подтверждено';return true;
  }
  view(extra={}){return {phase:this.phase,reason:this.reason,ready:this.phase!=='baseline',hint:this.phase==='baseline'?'Встаньте прямо':this.phase==='standing'?'Опускайтесь':'Вернитесь в исходное положение',increment:0,...extra};}
  update(f,t){
    if(!f?.valid||![f.angle,f.height,f.leg].every(Number.isFinite)||f.leg<=0){this.reset(f?.reason||'Не удаётся распознать движение');return this.view({tracking:false});}
    if(this.last!==null&&(t-this.last>C.maxGapMs||t<=this.last))this.reset('Пропуск кадров: встаньте прямо');
    if(this.side&&f.side!==this.side)this.reset('Смена стороны: встаньте прямо');
    this.side=f.side;this.last=t;
    const knee=this.knee.next(f.angle,t),height=this.height.next(f.height,t);
    if(this.phase==='baseline'){
      this.reason='Подтвердите положение стоя';
      // Reject a starting crouch. The candidate height must also stay stable.
      const isStraight=knee>=C.standAngle&&f.upright;
      if(!isStraight||this.candidate===null||Math.abs(height-this.candidate)>0.045*f.leg){this.standAt=null;this.candidate=isStraight?height:null;}
      if(stable(this,'standAt',isStraight,t,C.baselineMs)){
        this.baseHeight=height;this.baseLeg=f.leg;this.phase='standing';this.reason='Исходное положение подтверждено';
      }
      return this.view({tracking:true,metrics:{knee,drop:0}});
    }
    // Scale by current leg length so moving slightly towards the camera does
    // not look like a hip drop. Standing height is stored as a body proportion.
    const drop=this.baseHeight/this.baseLeg-height/f.leg;
    if(this.downAt!==null&&t-this.downAt>C.maxCycleMs){this.reset('Движение слишком долгое: встаньте прямо');return this.view({tracking:true});}
    let increment=0;
    if(this.phase==='standing'&&knee<C.descendAngle){this.phase='descending';this.downAt=t;this.reason='Опускание';}
    if(this.phase==='descending'){
      if(stable(this,'bottomAt',knee<=C.bottomAngle&&drop>=C.bottomDrop,t,C.bottomMs)){this.phase='bottom';this.reason='Нижнее положение подтверждено';}
      else if(knee>=C.standAngle&&drop<C.returnDrop){this.phase='standing';this.downAt=null;this.bottomAt=null;this.reason='Неполное движение';}
    }
    if(this.phase==='bottom'&&stable(this,'returnAt',knee>=C.standAngle&&drop<C.returnDrop,t,C.returnMs)){
      if(t-this.downAt>=C.minCycleMs){increment=1;this.reason='Повторение засчитано';}else this.reason='Слишком быстрое движение';
      this.phase='standing';this.downAt=null;this.bottomAt=null;this.returnAt=null;
    }
    return this.view({tracking:true,increment,metrics:{knee,drop}});
  }
}
// Lock the visible side; changing sides forces the counter to re-establish
// standing, so a different projection cannot finish an old repetition.
export function squatFeatures(points,w,h,preferred){
  if(!points||points.length<33)return {valid:false,reason:'Встаньте в кадр'};
  if(!(w>0&&h>0))return {valid:false,reason:'Не удаётся распознать движение'};
  const confidence=i=>Math.min(points[i]?.visibility??0,points[i]?.presence??1);
  const inFrame=i=>points[i]&&Number.isFinite(points[i].x)&&Number.isFinite(points[i].y)&&points[i].x>=0.01&&points[i].x<=0.99&&points[i].y>=0.01&&points[i].y<=0.99;
  const choices=[{name:'left',ids:[11,23,25,27,29,31]},{name:'right',ids:[12,24,26,28,30,32]}].map(s=>({...s,score:Math.min(...s.ids.map(i=>confidence(i)))}));
  const best=choices.sort((a,b)=>b.score-a.score)[0];
  const locked=choices.find(s=>s.name===preferred);
  const side=locked?.score>=C.visibility?locked:best;
  if(side.score<C.visibility){
    // Name a missing body part only when the surrounding torso is reliable.
    // Otherwise uncertainty does not justify guessing why detection failed.
    const torso=Math.max(Math.min(confidence(11),confidence(23)),Math.min(confidence(12),confidence(24)));
    if(torso>=C.visibility&&Math.max(confidence(25),confidence(26))<C.visibility)return {valid:false,reason:'Не видно колени'};
    if(torso>=C.visibility&&Math.max(confidence(27),confidence(28))<C.visibility)return {valid:false,reason:'Не видно стопы — тело должно быть целиком в кадре'};
    return {valid:false,reason:'Не удаётся распознать движение'};
  }
  if(side.ids.some(i=>!inFrame(i)))return {valid:false,reason:'Отойдите дальше: таз, колени и стопы должны быть в кадре'};
  const [shoulder,hip,knee,ankle]=side.ids.slice(0,4).map(i=>pixel(points[i],w,h));
  const leg=distance(hip,knee)+distance(knee,ankle),a=angle(hip,knee,ankle);
  if(!Number.isFinite(a)||leg<0.2*h)return {valid:false,reason:'Подойдите ближе: плохо видно тело'};
  return {valid:true,side:side.name,angle:a,height:ankle.y-hip.y,leg,upright:shoulder.y<hip.y&&Math.abs(shoulder.x-hip.x)<leg*0.5};
}
