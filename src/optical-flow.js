import {MOTION as C} from './config.js';
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??0;};
const norm=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function pyramid(gray,width,height){
  const levels=[{pixels:gray,width,height}];
  for(let l=1;l<3;l++){
    const prev=levels.at(-1),w=Math.floor(prev.width/2),h=Math.floor(prev.height/2),pixels=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=2*y*prev.width+2*x;pixels[y*w+x]=(prev.pixels[i]+prev.pixels[i+1]+prev.pixels[i+prev.width]+prev.pixels[i+prev.width+1]+2)>>2;}
    levels.push({pixels,width:w,height:h});
  }
  return levels;
}
function sample(im,x,y){
  const ix=Math.floor(x),iy=Math.floor(y),dx=x-ix,dy=y-iy,i=iy*im.width+ix;
  return (1-dy)*((1-dx)*im.pixels[i]+dx*im.pixels[i+1])+dy*((1-dx)*im.pixels[i+im.width]+dx*im.pixels[i+im.width+1]);
}
function inside(im,p,r=5){return p.x>=r&&p.y>=r&&p.x<im.width-r-1&&p.y<im.height-r-1;}
// Sparse pyramidal Lucas–Kanade. Velocity is a search seed only. Every accepted
// displacement must match actual pixels, pass a backward check and fit its
// hand's robust consensus. No period/cadence prediction enters counting.
export function trackPoint(a,b,p,guess={x:0,y:0}){
  let q;
  for(let l=a.length-1;l>=0;l--){
    const factor=2**l,from=a[l],to=b[l],origin={x:p.x/factor,y:p.y/factor};
    q=q?{x:q.x*2,y:q.y*2}:{x:(p.x+guess.x)/factor,y:(p.y+guess.y)/factor};
    if(!inside(from,origin)||!inside(to,q))return null;
    if(l===a.length-1){
      // A delivered camera frame may follow a skipped frame or a reversal.
      // Search a small coarse image neighbourhood before local optimisation;
      // constant velocity alone is a poor initial guess at clap endpoints.
      let best=q,bestError=Infinity;
      for(let sy=-4;sy<=4;sy+=2)for(let sx=-4;sx<=4;sx+=2){
        const candidate={x:q.x+sx,y:q.y+sy};if(!inside(to,candidate))continue;
        let error=0;
        for(let y=-2;y<=2;y++)for(let x=-2;x<=2;x++)error+=Math.abs(sample(from,origin.x+x,origin.y+y)-sample(to,candidate.x+x,candidate.y+y));
        if(error<bestError){bestError=error;best=candidate;}
      }
      q=best;
    }
    const patches=[];let xx=0,xy=0,yy=0;
    const radius=3;
    for(let y=-radius;y<=radius;y++)for(let x=-radius;x<=radius;x++){
      const px=origin.x+x,py=origin.y+y,ix=(sample(from,px+1,py)-sample(from,px-1,py))/2,iy=(sample(from,px,py+1)-sample(from,px,py-1))/2;
      patches.push({x,y,v:sample(from,px,py),ix,iy});xx+=ix*ix;xy+=ix*iy;yy+=iy*iy;
    }
    const determinant=xx*yy-xy*xy;if(determinant<1e-4)return null;
    for(let iteration=0;iteration<10;iteration++){
      if(!inside(to,q))return null;
      let bx=0,by=0;
      for(const k of patches){const error=k.v-sample(to,q.x+k.x,q.y+k.y);bx+=k.ix*error;by+=k.iy*error;}
      const dx=(yy*bx-xy*by)/determinant,dy=(xx*by-xy*bx)/determinant;
      if(!Number.isFinite(dx+dy)||Math.hypot(dx,dy)>6)return null;
      q.x+=dx;q.y+=dy;if(dx*dx+dy*dy<0.0025)break;
    }
  }
  if(!inside(b[0],q))return null;
  let residual=0;
  for(let y=-3;y<=3;y++)for(let x=-3;x<=3;x++)residual+=Math.abs(sample(a[0],p.x+x,p.y+y)-sample(b[0],q.x+x,q.y+y));
  return residual/49<=C.maxResidual?q:null;
}
function corner(im,x,y){
  let xx=0,xy=0,yy=0;
  for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){
    const n=(y+j)*im.width+x+i,gx=(im.pixels[n+1]-im.pixels[n-1])/2,gy=(im.pixels[n+im.width]-im.pixels[n-im.width])/2;
    xx+=gx*gx;xy+=gx*gy;yy+=gy*gy;
  }
  return (xx+yy-Math.sqrt((xx-yy)**2+4*xy*xy))/2;
}
function palm(hand){const ids=[0,5,9,13,17];return {x:ids.reduce((n,i)=>n+hand[i].x,0)/5,y:ids.reduce((n,i)=>n+hand[i].y,0)/5};}
export function seedHand(frame,landmarks){
  const im=frame.pyramid[0],hand=landmarks.map(p=>({x:p.x*im.width,y:p.y*im.height})),centre=palm(hand);
  const longitudinal=norm(hand[0],hand[9]),width=norm(hand[5],hand[17]),radius=Math.max(width,longitudinal)*.75;
  if(radius<5)return null;
  const candidates=[];
  for(let y=Math.max(6,Math.floor(centre.y-radius));y<Math.min(im.height-6,centre.y+radius);y+=2){
    for(let x=Math.max(6,Math.floor(centre.x-radius));x<Math.min(im.width-6,centre.x+radius);x+=2){
      // Stay near the detected palm/wrist rather than static background.
      if(Math.hypot(x-centre.x,y-centre.y)>radius)continue;
      if(!hand.some((p,i)=>[0,5,9,13,17].includes(i)&&Math.hypot(p.x-x,p.y-y)<Math.max(4,radius*.5)))continue;
      const score=corner(im,x,y);if(score>40)candidates.push({x,y,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);const points=[];
  for(const p of candidates){if(points.every(q=>norm(p,q)>4)){points.push({x:p.x,y:p.y});if(points.length>=C.maxPoints)break;}}
  return points.length>=C.minPoints?{points,landmarks:structuredClone(landmarks),frame,velocity:{x:0,y:0},intervalMs:16.667,anchor:frame.timestamp,confidence:1}:null;
}
export function advanceHand(track,from,to){
  if(!track||to.timestamp-track.anchor>C.maxAnchorMs||to.timestamp-from.timestamp>C.maxFrameGapMs)return null;
  const pairs=[];
  const factor=Math.min(3,(to.timestamp-from.timestamp)/(track.intervalMs||16.667));
  for(const p of track.points){
    const q=trackPoint(from.pyramid,to.pyramid,p,{x:track.velocity.x*factor,y:track.velocity.y*factor});if(!q)continue;
    const back=trackPoint(to.pyramid,from.pyramid,q,{x:p.x-q.x,y:p.y-q.y});
    if(back&&norm(back,p)<=C.maxBackwardError)pairs.push({p,q,dx:q.x-p.x,dy:q.y-p.y});
  }
  if(pairs.length<C.minPoints)return null;
  const dx=median(pairs.map(p=>p.dx)),dy=median(pairs.map(p=>p.dy));
  const inliers=pairs.filter(p=>Math.hypot(p.dx-dx,p.dy-dy)<2.5);
  if(inliers.length<C.minPoints||inliers.length<track.points.length*.3)return null;
  const mx=median(inliers.map(p=>p.dx)),my=median(inliers.map(p=>p.dy));
  const im=to.pyramid[0],landmarks=track.landmarks.map(p=>({...p,x:p.x+mx/im.width,y:p.y+my/im.height}));
  const centre=palm(landmarks);if(centre.x<0||centre.x>1||centre.y<0||centre.y>1)return null;
  // Refresh textured points inside the newly OBSERVED palm position before
  // they all age out during a turn. This does not refresh the neural anchor or
  // infer a missing palm: a successful two-way match is required first.
  const refreshed=inliers.length<C.maxPoints*.75?seedHand(to,landmarks):null;
  return {...track,frame:to,points:refreshed?.points??inliers.map(p=>p.q),landmarks,velocity:{x:mx,y:my},intervalMs:to.timestamp-from.timestamp,confidence:inliers.length/C.maxPoints};
}
export class HandMotionTracker {
  constructor(){this.reset();}
  reset(){this.history=[];this.tracks=[];this.discontinuity=false;this.reason='Ждём положение кистей от модели';}
  push(gray,width,height,timestamp){
    const frame={timestamp,pyramid:pyramid(gray,width,height)},previous=this.history.at(-1);
    if(previous&&(previous.pyramid[0].width!==width||previous.pyramid[0].height!==height)){this.reset();}
    else if(previous)this.tracks=this.tracks.map(t=>{
      if(!t)return null;
      const from=t.frame??previous,next=advanceHand(t,from,frame);
      // Keep a short-lived SEARCH template across a failed image match. It is
      // not emitted as an observation. A later fresh image must pass matching
      // from the last actually seen frame; no extrapolated landmarks count.
      return next??(timestamp-from.timestamp<=C.maxFrameGapMs?t:null);
    });
    this.history.push(frame);this.history=this.history.filter(f=>timestamp-f.timestamp<=C.historyMs).slice(-24);
    let tracks=this.tracks.filter(t=>t?.frame?.timestamp===timestamp);
    // If both tracks latch onto the same visible texture, their disappearance
    // is ambiguous, not proof that two distinct palms reached contact.
    if(tracks.length===2){
      const shared=tracks[0].points.filter(p=>tracks[1].points.some(q=>norm(p,q)<2)).length;
      const im=frame.pyramid[0],pixel=p=>({x:p.x*im.width,y:p.y*im.height});
      const separation=norm(pixel(palm(tracks[0].landmarks)),pixel(palm(tracks[1].landmarks)));
      const palmLength=tracks.reduce((s,t)=>s+norm(pixel(t.landmarks[0]),pixel(t.landmarks[9])),0)/2;
      if(shared>Math.min(tracks[0].points.length,tracks[1].points.length)*.6||separation<palmLength*.35)tracks=[];
    }
    const result={landmarks:tracks.map(t=>t.landmarks),confidence:tracks.length?Math.min(...tracks.map(t=>t.confidence)):0,
      anchorAgeMs:tracks.length?Math.max(...tracks.map(t=>timestamp-t.anchor)):null,
      discontinuity:this.discontinuity,reason:tracks.length===2?null:tracks.length?'Трекер видит одну кисть':'Недостаточно видимых деталей кистей'};
    this.discontinuity=false;return result;
  }
  seed(landmarks,timestamp){
    const index=this.history.findIndex(f=>Math.abs(f.timestamp-timestamp)<1);
    if(index<0)return {accepted:false,reason:'Результат модели устарел',anchorDelayMs:this.history.at(-1)?.timestamp-timestamp,historyFrames:this.history.length};
    const start=this.history[index];
    let candidates=landmarks.slice(0,2).map(hand=>seedHand(start,hand));
    const seeded=candidates.filter(Boolean).length;
    for(let i=index+1;i<this.history.length;i++)candidates=candidates.map(t=>advanceHand(t,this.history[i-1],this.history[i]));
    const valid=candidates.filter(Boolean);if(!valid.length)return {accepted:false,reason:'Не найдены устойчивые детали ладони',seededHands:seeded,modelHands:landmarks.length,anchorDelayMs:this.history.at(-1).timestamp-timestamp};
    const next=[...this.tracks];const used=new Set();
    // Match the pair jointly; greedy nearest-hand assignment can swap the
    // second hand when palms briefly overlap or MediaPipe reverses its order.
    let assignment=null;
    if(valid.length===2&&next.length===2&&next.every(Boolean)){
      const direct=norm(palm(valid[0].landmarks),palm(next[0].landmarks))+norm(palm(valid[1].landmarks),palm(next[1].landmarks));
      const crossed=norm(palm(valid[0].landmarks),palm(next[1].landmarks))+norm(palm(valid[1].landmarks),palm(next[0].landmarks));
      assignment=direct<=crossed?[0,1]:[1,0];
    }
    for(const [candidateIndex,candidate] of valid.entries()){
      const centre=palm(candidate.landmarks);let best=-1,bestDistance=Infinity;
      next.forEach((t,i)=>{if(t&&!used.has(i)&&(!assignment||i===assignment[candidateIndex])){const d=norm(centre,palm(t.landmarks));if(d<bestDistance){best=i;bestDistance=d;}}});
      if(best>=0&&bestDistance<.22){
        const old=next[best],observed=old.frame?.timestamp===this.history.at(-1).timestamp,scale=Math.max(.015,norm(candidate.landmarks[0],candidate.landmarks[9]));
        if(observed&&bestDistance>scale*.9){used.add(best);continue;}
        else if(observed){
          // Bound neural correction to avoid turning delayed landmark jitter
          // into a fresh approach/reopen event in the fast image stream.
          const prior=palm(old.landmarks),shift={x:(prior.x-centre.x)*.65,y:(prior.y-centre.y)*.65};
          candidate.landmarks=candidate.landmarks.map(p=>({...p,x:p.x+shift.x,y:p.y+shift.y}));
          // Points remain at measured pixels, only the drawn/feature geometry
          // is blended; the next displacement still comes from fresh matches.
          candidate.velocity=old.velocity;
          candidate.intervalMs=old.intervalMs;
        }
        next[best]=candidate;used.add(best);
      }else{
        const empty=next.findIndex((t,i)=>!t&&!used.has(i));
        if(empty>=0){next[empty]=candidate;used.add(empty);}else if(next.length<2){next.push(candidate);used.add(next.length-1);}
        else if(landmarks.length===2){this.discontinuity=true;this.tracks=valid;return {accepted:true,discontinuity:true};}
      }
    }
    this.tracks=next.slice(0,2);return {accepted:true,trackedHands:this.tracks.filter(Boolean).length,anchorDelayMs:this.history.at(-1).timestamp-timestamp};
  }
}
