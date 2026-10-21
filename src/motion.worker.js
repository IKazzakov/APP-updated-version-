import {HandMotionTracker} from './optical-flow.js';
import {FrameFusion} from './frame-fusion.js';
const tracker=new HandMotionTracker(),fusion=new FrameFusion();let epoch=null,canvas,context;
self.onmessage=({data})=>{
  try{
    if(data.type==='reset'){epoch=data.epoch;tracker.reset();fusion.reset();return;}
    if(data.epoch!==epoch){data.bitmap?.close();return;}
    if(data.type==='seed'){const result=tracker.seed(data.landmarks,data.timestamp);const repaired=fusion.anchor(data);self.postMessage({type:'anchor',epoch,...result,repaired});return;}
    if(data.type==='frame'){
      const start=performance.now(),width=data.bitmap.width,height=data.bitmap.height;
      if(!canvas){canvas=new OffscreenCanvas(width,height);context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('2D Canvas недоступен');}
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      try{context.drawImage(data.bitmap,0,0);}finally{data.bitmap.close();}
      const rgba=context.getImageData(0,0,width,height).data,gray=new Uint8Array(width*height);
      for(let i=0,j=0;i<gray.length;i++,j+=4)gray[i]=(rgba[j]*77+rgba[j+1]*150+rgba[j+2]*29)>>8;
      const result=tracker.push(gray,width,height,data.timestamp);
      const row={epoch,timestamp:data.timestamp,ms:performance.now()-start,inputWidth:width,inputHeight:height,source:'optical',...result};
      // Overlay stays at the latest image time. Only the counter's numeric
      // observations wait briefly for possible late model corrections.
      self.postMessage({type:'preview',...row});
      for(const ready of fusion.push(row))self.postMessage({type:'result',...ready});
    }
  }catch(e){data.bitmap?.close();self.postMessage({type:'error',message:e.message||String(e)});}
};
self.postMessage({type:'ready'});
