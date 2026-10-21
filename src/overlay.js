const POSE=[[11,12],[11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[27,31],[24,26],[26,28],[28,30],[30,32],[28,32],[11,13],[13,15],[12,14],[14,16]];
export function drawOverlay(canvas,sets,w,h,visible=true){
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);if(!visible)return;
  ctx.lineWidth=Math.max(2,w/300);ctx.lineCap='round';ctx.strokeStyle='#d1fc80';ctx.fillStyle='#d1fc80';
  const good=point=>point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&(point.visibility??0)>0.5;
  for(const points of sets){
    for(const [a,b] of POSE){if(!good(points[a])||!good(points[b]))continue;ctx.beginPath();ctx.moveTo(points[a].x*w,points[a].y*h);ctx.lineTo(points[b].x*w,points[b].y*h);ctx.stroke();}
    points.forEach((point,index)=>{if(index<11||!good(point))return;ctx.beginPath();ctx.arc(point.x*w,point.y*h,Math.max(3,w/220),0,Math.PI*2);ctx.fill();});
  }
}
