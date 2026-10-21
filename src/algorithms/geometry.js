export const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
export const pixel = (p,w,h) => ({x:p.x*w,y:p.y*h});
export function angle(a,b,c) {
  const u={x:a.x-b.x,y:a.y-b.y},v={x:c.x-b.x,y:c.y-b.y};
  const n=Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y);
  return n>1 ? Math.acos(Math.max(-1,Math.min(1,(u.x*v.x+u.y*v.y)/n)))*180/Math.PI : NaN;
}
export class Smoother {
  constructor(tau){this.tau=tau;this.reset();}
  reset(){this.value=null;this.time=null;}
  next(value,time){
    const alpha=this.time===null?1:1-Math.exp(-Math.max(0,time-this.time)/this.tau);
    this.value=this.value===null?value:this.value+alpha*(value-this.value);this.time=time;return this.value;
  }
}
export function stable(owner,key,condition,time,duration){
  if(!condition){owner[key]=null;return false;}
  owner[key]??=time;return time-owner[key]>=duration;
}
