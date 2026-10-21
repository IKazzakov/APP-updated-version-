import {FilesetResolver,PoseLandmarker} from '@mediapipe/tasks-vision';
let model=null;
self.onmessage=async({data})=>{
  try{
    if(data.type==='load'){
      self.postMessage({type:'status',message:'Загрузка модели · файл'});
      const response=await fetch(data.url,{credentials:'same-origin'});
      if(!response.ok)throw new Error(`Файл модели недоступен (HTTP ${response.status})`);
      const buffer=new Uint8Array(await response.arrayBuffer());
      if(buffer.byteLength<100000)throw new Error('Получен неверный файл модели. Откройте прямую ссылку сайта и войдите в аккаунт.');
      self.postMessage({type:'status',message:'Загрузка модели · запуск WASM'});
      const fileset=await FilesetResolver.forVisionTasks(data.wasm);
      model=await PoseLandmarker.createFromOptions(fileset,{
        baseOptions:{modelAssetBuffer:buffer,delegate:'CPU'},runningMode:'VIDEO',
        numPoses:1,minTrackingConfidence:0.6,minPoseDetectionConfidence:0.6,
        minPosePresenceConfidence:0.6,outputSegmentationMasks:false,
      });
      self.postMessage({type:'ready',delegate:'CPU'});
    }
    if(data.type==='frame'&&model){
      const started=performance.now(),inputWidth=data.bitmap.width,inputHeight=data.bitmap.height;let result;
      try{result=model.detectForVideo(data.bitmap,data.timestamp);}finally{data.bitmap.close();}
      self.postMessage({type:'result',epoch:data.epoch,timestamp:data.timestamp,
        ms:performance.now()-started,inputWidth,inputHeight,landmarks:result.landmarks||[]});
    }
  }catch(error){self.postMessage({type:'error',message:error?.message||String(error)});}
};
