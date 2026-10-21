// Bounded NUMERIC observation window, not an inference/frame processing queue.
// A short display-independent delay lets a real late neural observation repair
// a missed optical observation at the SAME capture time, in chronological order.
export class FrameFusion {
  constructor(delayMs=110){this.delayMs=delayMs;this.reset();}
  reset(){this.pending=[];this.last=-Infinity;}
  push(row){
    if(row.timestamp<=this.last||this.pending.some(p=>p.timestamp===row.timestamp))return [];
    this.pending.push(row);const ready=[];
    while(this.pending.length&&(row.timestamp-this.pending[0].timestamp>=this.delayMs||this.pending.length>12)){
      const r=this.pending.shift();this.last=r.timestamp;ready.push({...r,fusionDelayMs:row.timestamp-r.timestamp});
    }
    return ready;
  }
  anchor(data){
    if(data.landmarks.length!==2||data.timestamp<=this.last)return false;
    const row=this.pending.find(r=>Math.abs(r.timestamp-data.timestamp)<1);
    if(!row||row.landmarks.length===2)return false;
    row.landmarks=data.landmarks;row.confidence=1;row.anchorAgeMs=0;row.source='model-anchor';
    row.reason=null;return true;
  }
}
