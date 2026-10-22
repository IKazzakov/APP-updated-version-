import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera,cameraError} from '../src/camera.js';
test('camera requests video only; switch and off stop all previous tracks',async()=>{
 globalThis.isSecureContext=true;const streams=[],requests=[];
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async options=>{requests.push(options);const track={stopped:false,stop(){this.stopped=true;},addEventListener(){},getSettings(){return {width:1280,height:720};}};const stream={getTracks:()=>[track],getVideoTracks:()=>[track],track};streams.push(stream);return stream;}}}});
 const video={srcObject:null,play:async()=>{}};const c=new Camera(video);
 await c.start();assert.equal(requests[0].audio,false);await c.start('environment');assert.equal(streams[0].track.stopped,true);assert.equal(requests[1].video.facingMode.ideal,'environment');c.stop();assert.equal(streams[1].track.stopped,true);assert.equal(video.srcObject,null);
});
test('late camera permission response cannot resurrect stopped camera',async()=>{
 let release;const track={stopped:false,stop(){this.stopped=true;}};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(r=>release=r)}}});
 const c=new Camera({srcObject:null,play:async()=>{}}),pending=c.start();c.stop();release({getTracks:()=>[track]});assert.equal(await pending,false);assert.equal(track.stopped,true);assert.equal(c.stream,null);
});
test('camera denial explains how to retry',()=>{assert.match(cameraError({name:'NotAllowedError'}),/Разрешить/);assert.match(cameraError({name:'NotReadableError'}),/занята/);});
test('Android camera denial points to app permissions in system settings',()=>{
 const previous=globalThis.Capacitor;globalThis.Capacitor={isNativePlatform:()=>true};
 try{assert.match(cameraError({name:'NotAllowedError'}),/настройки Android.*Движение/);}finally{globalThis.Capacitor=previous;}
});
test('failed video playback releases acquired camera',async()=>{
 const track={stopped:false,stop(){this.stopped=true;},addEventListener(){}};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]})}}});
 const c=new Camera({srcObject:null,play:async()=>{throw new Error('playback failed');}});await assert.rejects(c.start(),/playback failed/);assert.equal(track.stopped,true);assert.equal(c.stream,null);
});
