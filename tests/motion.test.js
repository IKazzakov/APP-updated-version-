import test from 'node:test';
import assert from 'node:assert/strict';
import {HandMotionTracker,pyramid,trackPoint} from '../src/optical-flow.js';
import {clapFeatures,ClapCounter} from '../src/algorithms/clap.js';
const W=240,H=180;
function hands(distance=100){
  return [0,1].map(j=>Array.from({length:21},(_,i)=>{
    const centre=120+(j?1:-1)*distance/2;
    const xy=i===0?[0,12]:i===5?[-9,-3]:i===9?[0,-8]:i===13?[5,-5]:i===17?[9,0]:[(i%4-1.5)*5,-8-Math.floor(i/4)*2];
    return {x:(centre+xy[0])/W,y:(90+xy[1])/H,z:0};
  }));
}
// Deterministic textured patches, not landmarks-only counting. The tracker
// must recover subpixel motion from pixels, including delayed neural anchors.
function image(distance=100,{blank=false,one=false}={}){
  const gray=new Uint8Array(W*H).fill(25);if(blank)return gray;
  for(let j=0;j<(one?1:2);j++){
    const cx=120+(j?1:-1)*distance/2;
    for(let y=65;y<=114;y++)for(let x=Math.max(0,Math.floor(cx-15));x<Math.min(W,cx+16);x++){
      const px=x-cx,py=y-90;if((px/15)**2+(py/25)**2>1)continue;
      gray[y*W+x]=120+Math.round(35*Math.sin(px*.71+j*2)+32*Math.cos(py*.83)+24*Math.sin(px*.43+py*.61));
    }
  }
  return gray;
}
test('pyramidal optical flow measures fresh pixels and rejects blank texture',()=>{
  const a=pyramid(image(100),W,H),b=pyramid(image(95),W,H);
  const p={x:70,y:90},q=trackPoint(a,b,p);
  assert.ok(q);assert.ok(Math.abs(q.x-72.5)<.6);assert.ok(Math.abs(q.y-90)<.6);
  assert.equal(trackPoint(a,pyramid(image(100,{blank:true}),W,H),p),null);
});
test('late model anchor is propagated through retained frames to current image time',()=>{
  const t=new HandMotionTracker();t.push(image(100),W,H,0);t.push(image(96),W,H,16);t.push(image(92),W,H,32);
  assert.equal(t.seed(hands(100),0).accepted,true);
  const r=t.push(image(88),W,H,48);assert.equal(r.landmarks.length,2);
  const f=clapFeatures(r.landmarks,[],W,H);assert.equal(f.valid,true);assert.ok(Math.abs(f.distancePx-88)<1);
  assert.equal(r.anchorAgeMs,48);
});
test('missing neural detections do not discard two pixel-confirmed tracks',()=>{
  const t=new HandMotionTracker();t.push(image(100),W,H,0);t.seed(hands(),0);
  for(let i=1;i<12;i++){t.seed([],Math.max(0,(i-2)*16));const r=t.push(image(100-i*2),W,H,i*16);assert.equal(r.landmarks.length,2);}
});
test('a failed image match emits no hands; later pixels can recover the short-lived search template',()=>{
 const t=new HandMotionTracker();t.push(image(),W,H,0);t.seed(hands(),0);
 assert.equal(t.push(image(100,{blank:true}),W,H,16).landmarks.length,0);
 const recovered=t.push(image(96),W,H,32);assert.equal(recovered.landmarks.length,2);
 assert.ok(Math.abs(clapFeatures(recovered.landmarks,[],W,H).distancePx-96)<1);
});
test('disappearance, stale anchors, old results and long frame gaps cannot manufacture hands',()=>{
  for(const kind of ['blank','gap','age']){
    const t=new HandMotionTracker();t.push(image(),W,H,0);t.seed(hands(),0);
    let r;
    if(kind==='age')for(let i=1;i<=55;i++)r=t.push(image(),W,H,i*16);
    else r=t.push(image(100,{blank:kind==='blank'}),W,H,kind==='gap'?150:16);
    assert.ok(r.landmarks.length<2,kind);
    assert.equal(t.seed(hands(),-100).accepted,false);
  }
});
test('reset discards image history and unfinished tracks',()=>{
  const t=new HandMotionTracker();t.push(image(),W,H,0);t.seed(hands(),0);t.reset();
  assert.equal(t.push(image(),W,H,16).landmarks.length,0);assert.equal(t.seed(hands(),0).accepted,false);
});
test('two tracks using the same visible hand cannot confirm two distinct palms',()=>{
 const t=new HandMotionTracker();t.push(image(),W,H,0);const hand=hands()[0];t.seed([hand,hand],0);
 assert.equal(t.push(image(),W,H,16).landmarks.length,0);
});
for(const hz of [5,6])test(`pixel tracker plus counter counts ten ${hz}Hz cycles with delayed intermittent model anchors`,()=>{
  const tracker=new HandMotionTracker(),counter=new ClapCounter();let count=0,frame=0;
  const pending=[];
  const send=(d,t)=>{
    const result=tracker.push(image(d),W,H,t);
    const f=clapFeatures(result.landmarks,[],W,H);
    count+=counter.update(f,t).increment;
    // An NN update every sixth image arrives three frames late; zero-hand
    // model updates between anchors do not replace image observations.
    if(frame%6===0)pending.push({t,hand:hands(d),due:frame+3});
    while(pending[0]?.due<=frame){const p=pending.shift();tracker.seed(p.hand,p.t);}
    frame++;
  };
  for(let i=0;i<55;i++)send(100,i*1000/60);
  const start=55*1000/60,period=1000/hz;
  for(let e=0;e<10*period;e+=1000/60)send(62+38*Math.cos(2*Math.PI*e/period),start+e);
  for(let i=0;i<8;i++)send(100,start+10*period+i*1000/60);
  assert.equal(count,10,JSON.stringify(counter.attempts.map(a=>({n:a.id,s:a.status,r:a.reason,min:a.minimumRatio}))));
});
