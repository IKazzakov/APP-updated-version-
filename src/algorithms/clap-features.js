import {pixel,distance} from './geometry.js';

// All inter-hand geometry is in shared IMAGE pixels, with aspect correction.
// World landmarks from different hands have different origins and are not used.
export function clapFeatures(hands,handednessScores,w,h){
  const handCount=hands?.length??0;
  const invalid=(reason,code,extra={})=>({valid:false,reason,code,handCount,...extra});
  if(handCount===0)return invalid('Кисти не найдены — покажите обе руки','hands_missing');
  if(handCount>2)return invalid('Найдено больше двух кистей','hands_missing');
  if(hands.some(hand=>hand.length<21||hand.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))))return invalid('Некорректные координаты кистей','invalid_coordinates');
  // Left/right classification confidence is not a hand-presence score.
  const palms=hands.map(hand=>{
    const p=hand.map(v=>pixel(v,w,h)),ids=[0,5,9,13,17];
    const centre={x:ids.reduce((s,i)=>s+p[i].x,0)/5,y:ids.reduce((s,i)=>s+p[i].y,0)/5};
    const length=distance(p[0],p[9]);
    const inside=i=>hand[i].x>=0&&hand[i].x<=1&&hand[i].y>=0&&hand[i].y<=1;
    const visible=ids.filter(inside).length;
    return {centre,length,partial:visible<ids.length,
      // This width-dependent size is used for INITIAL calibration only.
      // Once armed, the counter uses distancePx / frozenReferenceScale.
      size:(length+distance(p[5],p[17]))/2,
      // Keep a partially cropped but mostly observed palm usable. Its centre
      // must still be in the image and >=3/5 base points must be visible.
      // A few predicted edge points are allowed, an off-screen palm is not.
      inFrame:centre.x>=0&&centre.x<=w&&centre.y>=0&&centre.y<=h&&visible>=3&&
        (inside(0)||inside(9))&&ids.every(i=>hand[i].x>=-0.08&&hand[i].x<=1.08&&hand[i].y>=-0.08&&hand[i].y<=1.08)};
  });
  if(!palms.every(p=>p.inFrame))return invalid('Кисти у края кадра — покажите ладони целиком','cropped');
  // Length, rather than projected width, prevents an edge-on palm from being
  // rejected just because it turns during a clap. Task presence thresholds stay on.
  if(Math.min(...palms.map(p=>p.length))<Math.min(w,h)*0.035)return invalid('Кисти слишком далеко — подойдите ближе','too_small');
  if(handCount===1){
    const centre=palms[0].centre;
    const isCenter=w>0&&h>0?centre.x>=w*0.15&&centre.x<=w*0.85&&centre.y>=h*0.1&&centre.y<=h*0.9:true;
    return invalid('Видна только одна кисть — покажите обе','hands_missing',{
      singleHand:true,
      isCenter,
      oneHandCenter:isCenter,
      centre,
      centres:[centre,centre],
      scale:palms[0].size,
      distancePx:0,
      ratio:0,
      palmLengths:[palms[0].length],
      partialHands:palms.filter(p=>p.partial).length
    });
  }
  if(Math.max(...palms.map(p=>p.length))/Math.min(...palms.map(p=>p.length))>3)return invalid('Кисти сильно различаются по размеру — держите их на одной глубине','scale_mismatch');
  const scale=(palms[0].size+palms[1].size)/2;
  const distancePx=distance(palms[0].centre,palms[1].centre);
  return {valid:true,distancePx,scale,ratio:distancePx/scale,handCount,handednessScores,
    centres:palms.map(p=>p.centre),palmLengths:palms.map(p=>p.length),partialHands:palms.filter(p=>p.partial).length};
}
