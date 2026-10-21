import {ROUND_MS} from './config.js';
const epoch=value=>typeof value==='number'?value:Date.parse(value);
export function serverTimeAtReceipt({serverNow,processingMs=0},roundTripMs){
  if(!Number.isFinite(serverNow)||!Number.isFinite(roundTripMs)||roundTripMs<0)throw new Error('Неверное время подтверждения');
  const processing=Number.isFinite(processingMs)&&processingMs>=0?processingMs:0;
  // serverNow is stamped at send time: server processing is not network travel.
  return serverNow+Math.max(0,roundTripMs-processing)/2;
}
// The timer uses a monotonic clock. Inference speed, skipped frames and wall
// clock adjustments cannot lengthen a round. Server timestamps bound its start.
export class RoundClock {
  constructor(now=()=>performance.now()){this.now=now;this.clear();}
  clear(){this.id=null;this.startAt=null;this.endAt=null;this.status='idle';}
  start({id,startsAt,endsAt,serverNow}){
    const start=epoch(startsAt),end=epoch(endsAt),server=epoch(serverNow);
    if(!id||!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(server)||server<start||end-start!==ROUND_MS)throw new Error('Неверные параметры минутного раунда');
    const elapsed=Math.max(0,server-start);
    if(elapsed>=ROUND_MS)throw new Error('Время раунда уже истекло');
    this.id=id;this.startAt=this.now()-elapsed;this.endAt=this.startAt+ROUND_MS;this.status='running';
  }
  elapsed(at=this.now()){return this.startAt===null?0:Math.max(0,at-this.startAt);}
  remaining(at=this.now()){return this.endAt===null?ROUND_MS:Math.max(0,this.endAt-at);}
  accepts(capturedAt,deliveredAt=this.now()){
    // A result queued before start or delivered after the end cannot extend it.
    return this.status==='running'&&capturedAt>=this.startAt&&capturedAt<this.endAt&&deliveredAt<this.endAt;
  }
  tick(){if(this.status==='running'&&this.now()>=this.endAt){this.status='completed';return true;}return false;}
  abort(){if(this.status!=='running')return false;this.status='interrupted';return true;}
}
