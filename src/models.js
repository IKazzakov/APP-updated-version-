import {MODELS,VERSION} from './config.js';
export class Vision {
  constructor({onResult,onStatus,onError}){Object.assign(this,{onResult,onStatus,onError});this.generation=0;this.worker=null;this.busy=false;this.ready=false;this.timer=null;}
  async load(key='full'){
    if(key!=='full')throw new Error('Для этих правил используется Pose Landmarker Full');
    this.close();const generation=this.generation;this.key=key;
    const worker=new Worker(`/assets/vision.worker.js?v=${VERSION}`);this.worker=worker;
    this.onStatus('Загрузка модели');
    return new Promise((resolve,reject)=>{
      let loaded=false;
      const fail=message=>{if(generation!==this.generation)return;clearTimeout(this.timer);this.busy=false;this.ready=false;worker.terminate();this.worker=null;const e=new Error(message);if(!loaded)reject(e);else this.onError(e);};
      this.cancel=()=>{if(!loaded)resolve(false);};
      this.timer=setTimeout(()=>fail('Модель не загрузилась за 90 секунд. Проверьте соединение и повторите попытку.'),90000);
      worker.onerror=e=>fail(e.message||'Ошибка модуля распознавания');
      worker.onmessage=({data})=>{
        if(generation!==this.generation)return;
        if(data.type==='status')this.onStatus(data.message);
        if(data.type==='ready'){loaded=true;clearTimeout(this.timer);this.timer=null;this.ready=true;this.onStatus('Готово');resolve(true);}
        if(data.type==='error')fail(data.message);
        if(data.type==='result'){this.busy=false;clearTimeout(this.timer);this.timer=null;this.onResult(data);}
      };
      worker.postMessage({type:'load',key,url:new URL(`/assets/models/${MODELS[key].file}`,location.href).href,wasm:new URL('/assets/wasm',location.href).href});
    });
  }
  detect(bitmap,timestamp,epoch){
    if(!this.ready||this.busy){bitmap.close();return;}
    this.busy=true;
    this.timer=setTimeout(()=>{this.close();this.onError(new Error('Распознавание не отвечает. Нажмите «Начать», чтобы повторить.'));},15000);
    try{this.worker.postMessage({type:'frame',bitmap,timestamp,epoch},[bitmap]);}
    catch(error){bitmap.close();this.busy=false;clearTimeout(this.timer);this.timer=null;throw error;}
  }
  close(){this.generation++;this.cancel?.();this.cancel=null;clearTimeout(this.timer);this.timer=null;this.worker?.terminate();this.worker=null;this.ready=false;this.busy=false;}
}
