// Only canonical branch aliases of the controlled movement-preview project.
const PREVIEW_ORIGIN=/^https:\/\/preview-[0-9a-f]{16}\.movement-preview\.pages\.dev$/;
const approvals=new WeakMap();
const methods=new Set(['GET','HEAD','POST']);
const headersAllowed=new Set(['authorization','content-type']);

export function isPreviewOrigin(origin){
  const match=typeof origin==='string'&&PREVIEW_ORIGIN.exec(origin);
  return Boolean(match&&match[0]===origin);
}

export function approveBrowserOrigin(request){
  if(!isPreviewOrigin(request.headers.get('origin')))return null;
  const approval=Object.freeze({});
  approvals.set(approval,{request,method:request.method,url:request.url,origin:request.headers.get('origin')});
  return approval;
}

export function isBrowserOriginApproved(request,approval){
  if((typeof approval!=='object'&&typeof approval!=='function')||approval===null)return false;
  const snapshot=approvals.get(approval);
  return Boolean(snapshot&&snapshot.request===request&&snapshot.method===request.method&&snapshot.url===request.url&&snapshot.origin===request.headers.get('origin'));
}

export function validPreflight(request){
  if(!methods.has(request.headers.get('access-control-request-method')))return false;
  const value=request.headers.get('access-control-request-headers');
  return !value||value.split(',').every(name=>headersAllowed.has(name.trim().toLowerCase()));
}

function addVary(headers,names){
  const existing=(headers.get('Vary')||'').split(',').map(value=>value.trim()).filter(Boolean);
  if(!existing.includes('*'))for(const name of names){
    if(!existing.some(value=>value.toLowerCase()===name.toLowerCase()))existing.push(name);
  }
  headers.set('Vary',existing.join(', '));
}

export function withPreviewCors(response,origin,{preflight=false}={}){
  const headers=new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin',origin);
  addVary(headers,preflight?['Origin','Access-Control-Request-Method','Access-Control-Request-Headers']:['Origin']);
  if(preflight){
    headers.set('Access-Control-Allow-Methods','GET, HEAD, POST');
    headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');
    headers.set('Access-Control-Max-Age','300');
    headers.set('Cache-Control','no-store');
  }
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
