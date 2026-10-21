export const CLAP_PROFILES = [
  {id:'fast-60',width:640,height:480,fps:60},
  {id:'detail-60',width:960,height:540,fps:60},
  {id:'fast-30',width:640,height:480,fps:30},
];
export const SQUAT_PROFILE={id:'squat',width:1280,height:720,fps:30};
export function constraints(profile,strict=false){
  return {width:{ideal:profile.width},height:{ideal:profile.height},
    frameRate:strict?{exact:profile.fps}:{ideal:profile.fps,max:profile.fps}};
}
// getCapabilities() describes ranges, not all supported combinations. We
// apply each candidate and inspect actual settings; requested 60 is not proof.
export async function chooseClapProfile(track,isCurrent=()=>true){
  const attempts=[];
  if(!track.applyConstraints)return {id:'browser',attempts,reason:'Браузер управляет настройками камеры'};
  for(const p of CLAP_PROFILES){
    if(!isCurrent())return null;
    try{
      await track.applyConstraints(constraints(p,true));
      if(!isCurrent())return null;
      const s=track.getSettings();
      attempts.push({id:p.id,width:s.width,height:s.height,fps:s.frameRate??null});
      if(s.frameRate>=p.fps-3)return {id:p.id,attempts,reason:p.fps===60?'Камера подтвердила режим 60 кадров/с':'60 кадров/с недоступны; выбран режим 30'};
    }catch(e){attempts.push({id:p.id,error:e.name||'Ошибка настройки'});}
  }
  // A camera may reject exact constraints while accepting a working default.
  try{await track.applyConstraints(constraints(CLAP_PROFILES[2]));}catch{/* Keep the still-working stream if constraints are unsupported. */}
  return isCurrent()?{id:'browser',attempts,reason:'Используется доступный браузеру режим камеры'}:null;
}
