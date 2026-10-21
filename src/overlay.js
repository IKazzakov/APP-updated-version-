const POSE=[[11,12],[11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[27,31],[24,26],[26,28],[28,30],[30,32],[28,32],[11,13],[13,15],[12,14],[14,16]];
const HAND=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
export function drawOverlay(canvas,sets,mode,w,h,visible){
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);if(!visible)return;
  ctx.lineWidth=Math.max(2,w/300);ctx.lineCap='round';
  sets.forEach((points,i)=>{
    ctx.strokeStyle=i?'#84dbff':'#d1fc80';ctx.fillStyle=ctx.strokeStyle;
    // Hand Landmarker leaves visibility unset; Tasks serializes it as zero.
    // It is meaningful for Pose only. Never hide valid hand coordinates for it.
    const good=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&(mode!=='squat'||(p.visibility??1)>0.5);
    for(const [a,b] of mode==='squat'?POSE:HAND){if(!good(points[a])||!good(points[b]))continue;ctx.beginPath();ctx.moveTo(points[a].x*w,points[a].y*h);ctx.lineTo(points[b].x*w,points[b].y*h);ctx.stroke();}
    points.forEach((p,index)=>{if(!good(p)||(mode==='squat'&&index<11))return;ctx.beginPath();ctx.arc(p.x*w,p.y*h,Math.max(3,w/220),0,Math.PI*2);ctx.fill();});
  });
}
