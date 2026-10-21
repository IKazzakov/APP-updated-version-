import {FilesetResolver,PoseLandmarker,HandLandmarker} from '@mediapipe/tasks-vision';
import {HandBackend} from './inference-backend.js';
let model=null,kind=null,backend=null;
async function loadModelBuffer(url){
  try{
    if(typeof caches!=='undefined'){
      const cache=await caches.open('exercise-models-v1');
      const matched=await cache.match(url);
      if(matched){
        self.postMessage({type:'status',message:'Загрузка модели · из кэша'});
        const buf=new Uint8Array(await matched.arrayBuffer());
        if(buf.byteLength>=100000)return buf;
      }
    }
  }catch{}

  self.postMessage({type:'status',message:'Загрузка модели · скачивание'});
  const response=await fetch(url,{credentials:'same-origin'});
  if(!response.ok)throw new Error(`Файл модели недоступен (HTTP ${response.status})`);
  const contentLength=Number(response.headers.get('content-length'))||0;
  let buffer;

  if(response.body&&contentLength>0){
    const reader=response.body.getReader();
    const chunks=[];
    let received=0,lastPct=-1;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      chunks.push(value);received+=value.length;
      const pct=Math.min(100,Math.round((received/contentLength)*100));
      if(pct!==lastPct&&(pct%10===0||pct===100)){
        lastPct=pct;
        self.postMessage({type:'status',message:`Загрузка модели · ${pct}%`});
      }
    }
    const combined=new Uint8Array(received);
    let offset=0;
    for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.length;}
    buffer=combined;
  }else{
    buffer=new Uint8Array(await response.arrayBuffer());
  }

  if(buffer.byteLength<100000)throw new Error('Получен неверный файл модели. Откройте прямую ссылку сайта и войдите в аккаунт.');
  try{
    if(typeof caches!=='undefined'){
      const cache=await caches.open('exercise-models-v1');
      await cache.put(url,new Response(buffer.buffer,{headers:{'content-type':'application/octet-stream','content-length':String(buffer.byteLength)}}));
    }
  }catch{}
  return buffer;
}

self.onmessage=async({data})=>{
  try{
    if(data.type==='load'){
      kind=data.key==='hands'?'hands':'pose';
      const buffer=await loadModelBuffer(data.url);
      self.postMessage({type:'status',message:'Загрузка модели · запуск WASM'});
      const fileset=await FilesetResolver.forVisionTasks(data.wasm);
      const options={baseOptions:{modelAssetBuffer:buffer,delegate:'CPU'},runningMode:'VIDEO'};
      self.postMessage({type:'status',message:'Загрузка модели · подготовка'});
      if(kind==='pose'){
        model=await PoseLandmarker.createFromOptions(fileset,{...options,numPoses:1,minTrackingConfidence:0.6,minPoseDetectionConfidence:0.6,minPosePresenceConfidence:0.6,outputSegmentationMasks:false});
      }else{
        backend=new HandBackend({
          onInfo:info=>self.postMessage({type:'backend',...info}),
          create:async delegate=>{
            let canvas;
            if(delegate==='GPU'){
              if(typeof OffscreenCanvas==='undefined')throw new Error('OffscreenCanvas не поддерживается');
              canvas=new OffscreenCanvas(1,1);
              if(!canvas.getContext('webgl2'))throw new Error('WebGL2 недоступен в Worker');
            }
            const createPromise=HandLandmarker.createFromOptions(fileset,{
              ...options,baseOptions:{modelAssetBuffer:buffer,delegate},...(canvas?{canvas}:{}),
              numHands:2,minTrackingConfidence:0.5,minHandDetectionConfidence:0.5,minHandPresenceConfidence:0.5,
            });
            if(delegate==='GPU'){
              const timeoutPromise=new Promise((_,reject)=>setTimeout(()=>reject(new Error('Превышено время ожидания WebGL (таймаут 5с)')),5000));
              return Promise.race([createPromise,timeoutPromise]);
            }
            return createPromise;
          },
        });
        await backend.load();
      }
      self.postMessage({type:'ready',...(backend?backend.info():{delegate:'CPU',backendStatus:'Выбран'})});
    }
    if(data.type==='frame'&&(model||backend)){
      const started=performance.now(),inputWidth=data.bitmap.width,inputHeight=data.bitmap.height,benchmarking=!!backend?.benchmarking;let result;
      try{result=backend?await backend.detect(data.bitmap,data.timestamp):model.detectForVideo(data.bitmap,data.timestamp);}finally{data.bitmap.close();}
      self.postMessage({type:'result',epoch:data.epoch,timestamp:data.timestamp,ms:performance.now()-started,inputWidth,inputHeight,benchmarking,
        ...(backend?backend.info():{delegate:'CPU',backendStatus:'Выбран',backendBenchmark:null,fallbackReason:null}),
        landmarks:result.landmarks||[],scores:result.handedness?.map(h=>h[0]?.score??0)||[]});
    }
  }catch(e){self.postMessage({type:'error',message:e?.message||String(e)});}
};
