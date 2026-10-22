// TEST ONLY: synthetic positions, never included in the application.
export const POSE_WORKER=`self.onmessage=async({data})=>{if(data.type==='load'){postMessage({type:'ready'});return;}if(data.type!=='frame')return;const phase=await fetch('/__test/pose').then(r=>r.json()).then(p=>p.name);data.bitmap.close();const points=Array.from({length:33},()=>({x:.5,y:.5,visibility:.95,presence:1}));const pose=phase==='bottom'?[[.43,.38],[.45,.65],[.60,.66],[.5,.85]]:phase==='down'?[[.48,.19],[.48,.45],[.56,.61],[.5,.85]]:[[.5,.15],[.5,.35],[.5,.60],[.5,.85]];for(const side of [[11,23,25,27,29,31],[12,24,26,28,30,32]]){side.forEach((id,i)=>{const p=pose[Math.min(i,3)];points[id]={x:p[0]+(i>3?.01:0),y:p[1]+(i>3?.01:0),visibility:side[0]===11?.98:.8,presence:1};});}postMessage({type:'result',testPose:phase,epoch:data.epoch,timestamp:data.timestamp,ms:2,landmarks:phase==='missing'?[]:[points]});};`;

// Observe delivery of synthetic frames without changing the production pipeline.
export const OBSERVE_POSES = () => {
  const OriginalWorker=window.Worker;
  window.testPoseFrames={sequence:0,name:null};
  window.Worker=class extends OriginalWorker {
    constructor(...args){super(...args);this.addEventListener('message',({data})=>{
      if(data.type==='result'&&data.testPose)window.testPoseFrames={sequence:window.testPoseFrames.sequence+1,name:data.testPose};
    });}
  };
};
