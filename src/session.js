import {SquatCounter} from './algorithms/squat.js';
import {ClapCounter} from './algorithms/clap.js';
export class ExerciseSession {
  constructor(){this.counts={squat:0,clap:0};this.mode='squat';this.paused=false;this.epoch=0;this.algorithms={squat:new SquatCounter(),clap:new ClapCounter()};}
  get algorithm(){return this.algorithms[this.mode];}
  get count(){return this.counts[this.mode];}
  restart(reason){this.epoch++;this.algorithm.reset(reason);}
  select(mode){this.restart('Смена упражнения');this.mode=mode;this.restart('Подтвердите исходное положение');}
  pause(){this.paused=true;this.restart('Пауза');}
  resume(){this.paused=false;this.restart('После паузы подтвердите исходное положение');}
  reset(){this.counts[this.mode]=0;this.restart('Счётчик сброшен');}
  update(features,time,epoch=this.epoch){if(this.paused||epoch!==this.epoch)return null;const result=this.algorithm.update(features,time);this.counts[this.mode]+=result.increment;return result;}
}
