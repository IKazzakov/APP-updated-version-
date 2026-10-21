import {SquatCounter} from './algorithms/squat.js';
// Session count is only the visible approach/round. Persistence belongs to the
// repetition outbox; resetting this counter must never delete saved progress.
export class ExerciseSession {
  constructor(){this.algorithm=new SquatCounter();this.count=0;this.paused=false;this.epoch=0;}
  restart(reason){this.epoch++;this.algorithm.reset(reason);}
  pause(){this.paused=true;this.restart('Пауза');}
  resume(){this.paused=false;this.restart('После паузы подтвердите исходное положение');}
  reset(){this.count=0;this.restart('Счётчик подхода сброшен');}
  update(features,time,epoch=this.epoch){
    if(this.paused||epoch!==this.epoch)return null;
    const result=this.algorithm.update(features,time);this.count+=result.increment;return result;
  }
}
