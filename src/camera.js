export function cameraError(error){
  if(error.name==='NotAllowedError'||error.name==='SecurityError')return 'Доступ к камере запрещён. Нажмите значок рядом с адресом сайта → Разрешения → Камера → Разрешить. Затем повторите запуск.';
  if(error.name==='NotFoundError')return 'Камера не найдена. Подключите камеру и повторите попытку.';
  if(error.name==='NotReadableError')return 'Камера занята другим приложением. Закройте его и повторите запуск.';
  if(error.name==='OverconstrainedError')return 'Эта камера не поддерживает нужный режим. Попробуйте другую камеру.';
  return error.message||'Не удалось включить камеру. Повторите запуск.';
}
export class Camera {
  constructor(video,onEnded){this.video=video;this.stream=null;this.generation=0;this.onEnded=onEnded;}
  async start(facing='user'){
    this.stop();const generation=this.generation;
    if(!globalThis.isSecureContext)throw new Error('Камера работает только по HTTPS или на localhost. Откройте прямую ссылку сайта в Chrome.');
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Камера недоступна здесь. Откройте прямую ссылку отдельной вкладкой Chrome.');
    // Ideal constraints permit the browser to choose its closest supported
    // mode. A permission race may never resurrect a stopped video stream.
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}});
    if(generation!==this.generation){stream.getTracks().forEach(track=>track.stop());return false;}
    this.stream=stream;this.video.srcObject=stream;
    stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(this.stream===stream)this.onEnded?.();}));
    try{await this.video.play();}catch(error){if(generation===this.generation)this.stop();throw error;}
    return generation===this.generation;
  }
  stop(){this.generation++;this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;this.video.srcObject=null;}
  get settings(){return this.stream?.getVideoTracks()[0]?.getSettings()||{};}
}
