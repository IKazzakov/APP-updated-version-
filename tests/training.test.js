import test from 'node:test';
import assert from 'node:assert/strict';
import {Training} from '../src/training.js';
import {RoundClock} from '../src/round-clock.js';
function harness(){
  const doc=new EventTarget();doc.hidden=false;globalThis.document=doc;globalThis.window=new EventTarget();
  const context={clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){}};
  const video={srcObject:null,videoWidth:600,videoHeight:1000};
  let now=0;const events=[],ends=[],engine=new Training(video,{width:600,height:1000,getContext:()=>context},{onRepetition:event=>events.push(event),onRoundEnd:event=>ends.push(event)});
  engine.active=true;engine.clock=new RoundClock(()=>now);engine.settleUntil=0;
  const pose=(bottom=false)=>{
    const points=Array.from({length:33},()=>({x:0.5,y:0.5,visibility:0.99,presence:0.99}));
    for(const [shoulder,hip,knee,ankle,heel,foot] of [[11,23,25,27,29,31],[12,24,26,28,30,32]]){
      points[shoulder]={...points[shoulder],x:0.5,y:0.2};
      points[hip]={...points[hip],x:bottom?220/600:0.5,y:bottom?0.5:0.4};
      points[knee]={...points[knee],x:bottom?400/600:0.5,y:bottom?0.65:0.6};
      for(const index of [ankle,heel,foot])points[index]={...points[index],x:0.5,y:0.8};
    }
    return [points];
  };
  return {engine,events,ends,doc,hold(bottom,ms){for(let i=0;i<Math.ceil(ms/40);i++){now+=40;engine.consume({epoch:engine.session.epoch,timestamp:now,ms:20,landmarks:bottom===null?[]:pose(bottom)});}},
    get now(){return now;},set now(value){now=value;},start(){engine.beginRound({id:'round-test',startsAt:100000,endsAt:160000,serverNow:100000});},close(){engine.destroy();}};
}
test('training preparation never scores; active minute records complete cycles only',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);assert.equal(h.engine.state.ready,true);
    h.hold(true,800);h.hold(false,1000);assert.equal(h.events.length,0);assert.equal(h.engine.state.count,0);
    h.start();h.hold(false,1000);h.hold(true,800);h.hold(false,1000);assert.equal(h.events.length,1);assert.equal(h.events[0].roundId,'round-test');assert.ok(h.events[0].elapsedMs>0);
    h.engine.abortRound();assert.equal(h.ends.length,1);assert.equal(h.ends[0].status,'interrupted');
  }finally{h.close();}
});
test('loss of body and return during active minute cannot finish an old cycle',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();h.hold(false,1000);h.hold(true,800);h.hold(null,80);h.hold(false,1000);assert.equal(h.events.length,0);
    h.hold(true,800);h.hold(false,1000);assert.equal(h.events.length,1);
  }finally{h.close();}
});
test('minute ends independently of tracking and ignores inference delivered afterwards',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();h.hold(false,1000);h.hold(true,800);
    h.now=61000;h.engine.tick();h.hold(false,1200);assert.equal(h.events.length,0);assert.equal(h.ends.length,1);assert.equal(h.ends[0].status,'completed');assert.equal(h.engine.state.roundStatus,'completed');
  }finally{h.close();}
});
test('background interrupts minute once; ordinary session pauses instead',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));h.engine.stopCamera();assert.equal(h.ends.length,1);assert.equal(h.ends[0].status,'interrupted');
    h.engine.mode='practice';h.engine.active=true;h.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(h.engine.state.paused,true);
  }finally{h.close();}
});
test('camera off releases stream, terminates model and interrupts active round',()=>{
  const h=harness();try{
    let stopped=0,terminated=0;h.engine.camera.stream={getTracks:()=>[{stop(){stopped++;}}]};h.engine.vision.worker={terminate(){terminated++;}};
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();h.engine.stopCamera();assert.equal(stopped,1);assert.equal(terminated,1);assert.equal(h.ends[0].status,'interrupted');assert.equal(h.engine.state.cameraOn,false);
  }finally{h.close();}
});
test('verified standing can start immediately without a second preparation dwell',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();h.hold(false,40);h.hold(true,800);h.hold(false,1000);assert.equal(h.events.length,1);
  }finally{h.close();}
});
test('a crouched first frame cannot reuse pre-start standing to finish an old cycle',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();h.hold(true,800);h.hold(false,1000);assert.equal(h.events.length,0);
  }finally{h.close();}
});
test('stale standing observation cannot start a timed round',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.now+=500;assert.equal(h.engine.beginRound({id:'stale',startsAt:100000,endsAt:160000,serverNow:100000}),false);
  }finally{h.close();}
});

test('a valid fractional-millisecond final repetition stays strictly below the server deadline',()=>{
  const h=harness();try{
    h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);h.start();
    // Exercise event serialization at the valid half-open window boundary;
    // cycle recognition itself is covered by complete geometry sequences above.
    h.engine.session.update=()=>({tracking:true,phase:'standing',ready:true,hint:'Опускайтесь',increment:1});
    h.now=h.engine.clock.endAt-0.4;
    h.engine.consume({epoch:h.engine.session.epoch,timestamp:h.now,ms:20,landmarks:[]});
    assert.equal(h.events.length,1);assert.equal(h.events[0].elapsedMs,59999);
    assert.ok(Number.isSafeInteger(h.events[0].elapsedMs));
    h.now=h.engine.clock.endAt;
    h.engine.consume({epoch:h.engine.session.epoch,timestamp:h.now,ms:20,landmarks:[]});
    assert.equal(h.events.length,1);
  }finally{h.close();}
});
test('single detection miss during preparation recovers calibrated standing, while active-round loss still resets',()=>{
 const h=harness();try{
  h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);assert.equal(h.engine.state.poseReady,true);
  h.hold(null,40);assert.equal(h.engine.state.poseReady,false);h.hold(false,40);assert.equal(h.engine.state.ready,true);
  h.start();h.hold(false,40);h.hold(true,800);h.hold(null,40);h.hold(false,1000);assert.equal(h.events.length,0);
 }finally{h.close();}
});
test('a confirmed delayed start begins the clock after pose loss, but cannot complete a pre-start movement',()=>{
 const h=harness();try{
  h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);const permit=h.engine.captureStartPermit();assert.ok(permit);
  h.hold(true,800);h.hold(null,1200);assert.equal(h.engine.state.ready,false);
  assert.equal(h.engine.beginRound({id:'delayed',startsAt:100000,endsAt:160000,serverNow:102000},permit),true);
  assert.equal(h.engine.state.roundStatus,'running');assert.equal(h.engine.clock.remaining(),58000);
  h.hold(false,1000);assert.equal(h.events.length,0);h.hold(true,800);h.hold(false,1000);assert.equal(h.events.length,1);
 }finally{h.close();}
});
test('a start permit cannot survive camera off or a new preparation',()=>{
 const h=harness();try{
  h.engine.mode='personal';h.engine.roundStatus='preparing';h.hold(false,1000);const permit=h.engine.captureStartPermit();h.engine.stopCamera();
  h.engine.active=true;h.engine.roundStatus='preparing';h.hold(false,1000);assert.equal(h.engine.state.ready,true);
  assert.equal(h.engine.beginRound({id:'stale-permit',startsAt:100000,endsAt:160000,serverNow:100000},permit),false);
 }finally{h.close();}
});
