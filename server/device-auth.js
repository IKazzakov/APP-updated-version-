const SECRET=/^[a-f0-9]{64}$/;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export const authError=(code,status=401)=>json({error:{code}},status);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');

export async function authenticateDevice(request,db){
  const secret=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!secret)return null;
  const tokenHash=await hash(secret);
  const session=await db.prepare('SELECT user_id,revoked_at FROM device_sessions WHERE token_hash=?').bind(tokenHash).first();
  return session&&session.revoked_at===null?{userId:session.user_id,tokenHash}:null;
}

export async function registerDevice(request,env){
  if(!request.headers.get('content-type')?.startsWith('application/json'))return authError('JSON_REQUIRED',415);
  if(Number(request.headers.get('content-length'))>1024)return authError('TOO_LARGE',413);
  const reader=request.body?.getReader();let raw='',size=0;
  const decoder=new TextDecoder();
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();return authError('TOO_LARGE',413);}raw+=decoder.decode(value,{stream:true});}
  raw+=decoder.decode();
  let body;try{body=JSON.parse(raw);}catch{return authError('INVALID_JSON',400);}
  if(!body||typeof body!=='object'||Object.keys(body).length!==1||!SECRET.test(body.secret))return authError('INVALID_REQUEST',400);
  const tokenHash=await hash(body.secret);
  let row=await env.DB.prepare('SELECT user_id,revoked_at FROM device_sessions WHERE token_hash=?').bind(tokenHash).first();
  if(!row){
    if(env.AUTH_LIMITER){
      const {success}=await env.AUTH_LIMITER.limit({key:request.headers.get('cf-connecting-ip')||'local'});
      if(!success)return authError('RATE_LIMITED',429);
    }
    await env.DB.prepare('INSERT INTO device_sessions(token_hash,user_id,created_at) VALUES(?,?,?) ON CONFLICT(token_hash) DO NOTHING').bind(tokenHash,`device_${crypto.randomUUID()}`,Date.now()).run();
    row=await env.DB.prepare('SELECT user_id,revoked_at FROM device_sessions WHERE token_hash=?').bind(tokenHash).first();
  }
  if(row.revoked_at!==null)return authError('SESSION_REVOKED');
  // The individual random secret is generated and persisted on the device
  // before this idempotent request. Only its hash is stored in D1.
  return json({userId:row.user_id,authentication:'device-token'});
}

export async function revokeDevice(session,db){
  await db.prepare('UPDATE device_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(Date.now(),session.tokenHash).run();
  return json({ok:true});
}
