// Accumulate deadlines rather than rounding every interval up to a whole
// camera frame. At 30fps, "wait >= 111ms since last send" gives 7.5Hz, not 9Hz.
// Backpressure still drops frames; this never schedules or replays old images.
export class FrameCadence {
  constructor(){this.reset();}
  reset(){this.next=-Infinity;this.last=-Infinity;}
  due(time){return time>this.last&&time+2>=this.next;}
  sent(time,hz){
    const interval=1000/hz;
    this.next=!Number.isFinite(this.next)||time-this.next>interval?time+interval:this.next+interval;
    this.last=time;
  }
}
