const p95=a=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*.95)-1]??0;
export class AutoProfile {
  constructor(){this.reset();}
  reset(){this.neuralHz=12;this.motionEdge=320;this.neural=[];this.modelQuality=[];this.motion=[];this.lastDecision=-Infinity;this.lastWindow=-Infinity;this.badWindows=0;this.reason='Измеряем скорость камеры и отслеживания';this.lastModelDecision=-Infinity;this.delegate='CPU';}
  observeModel(data,valid=data.landmarks?.length===2){
    if(data.delegate)this.delegate=data.delegate;
    if(!data.benchmarking){this.modelQuality.push({t:data.timestamp,valid});this.modelQuality=this.modelQuality.filter(r=>data.timestamp-r.t<2000);}
    if(data.benchmarking||!data.landmarks?.length||!Number.isFinite(data.ms))return;
    this.neural.push(data.ms);this.neural=this.neural.slice(-24);
    if(this.neural.length<6||data.timestamp-this.lastModelDecision<2000)return;
    // Leave CPU/GPU time for camera delivery, tracking, drawing and buttons.
    const p=p95(this.neural);
    const isGpu=this.delegate==='GPU'||data.delegate==='GPU';
    let hz;
    if(isGpu){
      if(p<=20)hz=18;
      else if(p<=30)hz=Math.round(18-(p-20)*0.3);
      else hz=Math.max(6,Math.min(18,Math.floor(450/p)));
    }else{
      hz=Math.max(6,Math.min(20,Math.floor(650/p)));
    }
    if(Math.abs(hz-this.neuralHz)>=2){this.neuralHz=hz;this.reason=`Частота модели ${hz}/с по времени обработки`;}
    this.lastModelDecision=data.timestamp;
  }
  observeMotion(data){this.motion.push({t:data.timestamp,ms:data.ms,valid:(data.valid??data.landmarks.length===2)&&data.source!=='model-anchor'});this.motion=this.motion.filter(x=>data.timestamp-x.t<2000);}
  get opticalValidRate(){return this.motion.length?this.motion.filter(r=>r.valid).length/this.motion.length:0;}
  get modelValidRate(){return this.modelQuality.length?this.modelQuality.filter(r=>r.valid).length/this.modelQuality.length:0;}
  decide(now,{idle,cameraFps,profileId}){
    if(this.motion.length<20)return null;
    const times=this.motion.map(x=>x.ms),slow=p95(times)>14;
    // A usable two-palm neural result with poor pixel tracking is different
    // from genuinely absent hands. Keep tracking alive and lighten it first.
    const weak=this.modelQuality.length>=6&&this.modelValidRate>=.5&&this.opticalValidRate<.25;
    // Measure during a series as well. Apply the pending reduction at the
    // first safe gap, rather than requiring several seconds of stationary rest.
    if(now-this.lastWindow>=2000){
      this.lastWindow=now;this.badWindows=slow||weak?this.badWindows+1:0;
    }
    if(!idle||this.badWindows<3||now-this.lastDecision<15000)return null;
    this.lastDecision=now;this.badWindows=0;
    if(this.motionEdge>256){this.motionEdge=256;this.reason=slow?'Уменьшен кадр трекера: длительная нагрузка':'Уменьшен кадр трекера: модель видит кисти, пиксельные опоры неустойчивы';return {motionEdge:256};}
    if(slow&&cameraFps>35&&profileId!=='fast-30'){this.reason='Камера 30 кадров/с: трекер не успевает после уменьшения кадра';return {cameraProfile:{id:'fast-30',width:640,height:480,fps:30}};}
    return null;
  }
  snapshot(){return {neuralTargetFps:this.neuralHz,motionInputMaxEdge:this.motionEdge,neuralP95Ms:Math.round(p95(this.neural)*10)/10,motionP95Ms:Math.round(p95(this.motion.map(x=>x.ms))*10)/10,opticalValidRate:Math.round(this.opticalValidRate*1000)/1000,modelValidRate:Math.round(this.modelValidRate*1000)/1000,reason:this.reason};}
}
