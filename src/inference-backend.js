import {HAND_BACKEND as C} from './config.js';

const median=values=>{
  const sorted=[...values].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2;
};

// Hand-only backend selection. Benchmark the SAME fresh frames on both
// delegates during initial preparation, close the loser, then run one model.
// Pose keeps its existing CPU path. No frames are retained by this class.
export class HandBackend {
  constructor({create,clock=()=>performance.now(),onInfo=()=>{}}){
    this.create=create;this.clock=clock;this.onInfo=onInfo;
    this.models={};this.delegate='CPU';this.benchmarking=false;
    this.frames=0;this.samples={CPU:[],GPU:[]};this.warmup={CPU:[],GPU:[]};this.earlyExit=false;this.fallbackReason=null;
  }
  info(){
    return {delegate:this.delegate,backendStatus:this.benchmarking?'Сравнение CPU и GPU':'Выбран',
      backendBenchmark:{samples:this.samples.CPU.length,earlyExit:this.earlyExit,
        cpuMs:this.samples.CPU.length?Math.round(median(this.samples.CPU)*10)/10:null,
        gpuMs:this.samples.GPU.length?Math.round(median(this.samples.GPU)*10)/10:null},
      fallbackReason:this.fallbackReason};
  }
  report(){this.onInfo(this.info());}
  discard(delegate){try{this.models[delegate]?.close();}catch{}delete this.models[delegate];}
  async load(){
    try{this.models.GPU=await this.create('GPU');}
    catch(e){this.fallbackReason=`GPU недоступен: ${e.message}`;}
    try{this.models.CPU=await this.create('CPU');}
    catch(e){
      if(!this.models.GPU)throw e;
      this.fallbackReason=`Сравнение с CPU недоступно: ${e.message}`;
    }
    this.delegate=this.models.GPU?'GPU':'CPU';
    this.benchmarking=!!(this.models.GPU&&this.models.CPU);
    this.report();
  }
  measure(delegate,bitmap,timestamp){
    const start=this.clock(),result=this.models[delegate].detectForVideo(bitmap,timestamp);
    return {result,ms:this.clock()-start};
  }
  async cpuFallback(bitmap,timestamp,error){
    this.discard('GPU');this.benchmarking=false;this.delegate='CPU';
    this.fallbackReason=`GPU остановлен, включён CPU: ${error.message}`;
    this.models.CPU??=await this.create('CPU');
    this.report();return this.measure('CPU',bitmap,timestamp).result;
  }
  async detect(bitmap,timestamp){
    let result;
    try{result=this.measure(this.delegate,bitmap,timestamp);}
    catch(e){
      if(this.delegate!=='GPU')throw e;
      return this.cpuFallback(bitmap,timestamp,e);
    }
    if(!this.benchmarking)return result.result;
    let cpu;
    try{cpu=this.measure('CPU',bitmap,timestamp);}
    catch(e){
      this.fallbackReason=`CPU недоступен при сравнении: ${e.message}`;
      this.benchmarking=false;this.discard('CPU');this.report();return result.result;
    }
    this.frames++;
    if(this.frames<=C.warmupFrames){this.warmup.GPU.push(result.ms);this.warmup.CPU.push(cpu.ms);}
    if(this.frames===C.warmupFrames&&this.warmup.GPU.every((ms,i)=>ms>C.slowGpuMs&&ms>this.warmup.CPU[i]*C.slowGpuFactor)){
      this.samples=this.warmup;this.earlyExit=true;this.delegate='CPU';this.benchmarking=false;
      this.fallbackReason='GPU значительно медленнее CPU: сравнение завершено раньше';
      this.discard('GPU');this.report();return cpu.result;
    }
    if(this.frames>C.warmupFrames){this.samples.GPU.push(result.ms);this.samples.CPU.push(cpu.ms);}
    if(this.samples.CPU.length>=C.sampleFrames){
      // GPU must be measurably faster, not just available. CPU remains useful
      // on software WebGL, unsupported devices, and after context loss.
      this.delegate=median(this.samples.GPU)<median(this.samples.CPU)*C.gpuAdvantage?'GPU':'CPU';
      this.benchmarking=false;
      this.discard(this.delegate==='GPU'?'CPU':'GPU');this.report();
      if(this.delegate==='CPU')return cpu.result;
    }
    return result.result;
  }
  close(){this.discard('GPU');this.discard('CPU');}
}
