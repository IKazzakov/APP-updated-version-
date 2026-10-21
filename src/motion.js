import {VERSION} from './config.js';
export class MotionVision {
  constructor({onResult,onError,onAnchor,onPreview}){Object.assign(this,{onResult,onError,onAnchor,onPreview});this.worker=null;this.busy=false;this.ready=false;this.generation=0;}
  async load(epoch){
    this.close();const gen=this.generation;this.epoch=epoch;
    if(typeof OffscreenCanvas==='undefined')return false;
    return new Promise(resolve=>{
      const worker=this.worker=new Worker(`/assets/motion.worker.js?v=${VERSION}`);
      this.cancel=()=>resolve(false);
      const fail=message=>{if(gen!==this.generation)return;this.close();resolve(false);this.onError(message);};
      this.timer=setTimeout(()=>fail('Быстрый трекер не отвечает'),5000);
      worker.onerror=e=>fail(e.message||'Быстрый трекер недоступен');
      worker.onmessage=({data})=>{
        if(gen!==this.generation)return;
        if(data.type==='ready'){clearTimeout(this.timer);this.ready=true;this.reset(epoch);resolve(true);}
        if(data.type==='error')fail(data.message);
        if(data.type==='anchor'&&data.epoch===this.epoch)this.onAnchor?.(data);
        if(data.type==='preview'){this.busy=false;clearTimeout(this.frameTimer);this.onPreview?.(data);}
        if(data.type==='result')this.onResult(data);
      };
    });
  }
  reset(epoch){this.epoch=epoch;this.worker?.postMessage({type:'reset',epoch});}
  seed(data){if(this.ready&&data.epoch===this.epoch)this.worker.postMessage({type:'seed',epoch:data.epoch,timestamp:data.timestamp,landmarks:data.landmarks});}
  detect(bitmap,timestamp,epoch){
    if(!this.ready||this.busy){bitmap.close();return;}
    this.busy=true;this.frameTimer=setTimeout(()=>{this.close();this.onError('Быстрый трекер не успевает отвечать');},1500);
    this.worker.postMessage({type:'frame',bitmap,timestamp,epoch},[bitmap]);
  }
  close(){this.cancel?.();this.cancel=null;this.generation++;clearTimeout(this.timer);clearTimeout(this.frameTimer);this.worker?.terminate();this.worker=null;this.ready=false;this.busy=false;}
}
