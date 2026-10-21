import {chooseClapProfile,constraints,CLAP_PROFILES,SQUAT_PROFILE} from './camera-profiles.js';
export function cameraError(error){
  if(error.name==='NotAllowedError'||error.name==='SecurityError')return 'Доступ к камере запрещён. Нажмите значок рядом с адресом сайта → Разрешения → Камера → Разрешить. Затем нажмите «Начать».';
  if(error.name==='NotFoundError')return 'Камера не найдена. Подключите камеру и повторите попытку.';
  if(error.name==='NotReadableError')return 'Камера занята другим приложением. Закройте его и нажмите «Начать».';
  if(error.name==='OverconstrainedError')return 'Эта камера не поддерживает нужный режим. Попробуйте другую камеру.';
  return error.message||'Не удалось включить камеру. Нажмите «Начать», чтобы повторить.';
}
export class Camera {
  constructor(video,onEnded){this.video=video;this.stream=null;this.generation=0;this.onEnded=onEnded;this.profile=null;this.queue=Promise.resolve();this.profileGeneration=0;}
  async start(facing='user',mode='squat'){
    this.stop();const generation=this.generation;
    if(!globalThis.isSecureContext)throw new Error('Камера работает только по HTTPS или на localhost. Откройте прямую ссылку сайта в Chrome.');
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Камера недоступна здесь. Откройте прямую ссылку отдельной вкладкой Chrome.');
    const profile=mode==='clap'?CLAP_PROFILES[0]:SQUAT_PROFILE;
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},...constraints(profile)}});
    if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return false;}
    this.stream=stream;this.video.srcObject=stream;
    stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(this.stream===stream)this.onEnded?.();}));
    try{await this.selectMode(mode);if(generation!==this.generation)return false;await this.video.play();}catch(e){if(generation===this.generation)this.stop();throw e;}
    return generation===this.generation;
  }
  selectMode(mode,forcedProfile=null){
    const generation=this.generation,request=++this.profileGeneration,stream=this.stream;
    const current=()=>generation===this.generation&&request===this.profileGeneration&&stream===this.stream;
    const task=async()=>{
      if(!current())return false;
      const track=stream?.getVideoTracks()[0];if(!track)return false;
      let result;
      if(mode==='clap'&&!forcedProfile)result=await chooseClapProfile(track,current);
      else{
        const p=forcedProfile??SQUAT_PROFILE;
        if(track.applyConstraints)await track.applyConstraints(constraints(p));
        result={id:p.id,attempts:[],reason:mode==='clap'?'Настройка по измеренной нагрузке':'Профиль приседаний'};
      }
      if(!current())return false;
      const {width,height,frameRate,facingMode}=track.getSettings();
      this.profile={...result,actual:{width,height,frameRate,facingMode}};return true;
    };
    const pending=this.queue.catch(()=>{}).then(task);this.queue=pending;return pending;
  }
  stop(){this.generation++;this.profileGeneration++;if(this.stream)this.stream.getTracks().forEach(t=>t.stop());this.stream=null;this.video.srcObject=null;}
  get settings(){return this.stream?.getVideoTracks()[0]?.getSettings()||{};}
}
