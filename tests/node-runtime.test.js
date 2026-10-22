import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNodeServer} from '../server/node.js';

test('Node deployment serves real JSON API, preserves database on restart, handles proxy HTTPS and does not accept forged Sites identities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'movement-node-'));
  await writeFile(join(root,'index.html'),'<html>movement test client</html>');
  let app;
  async function start(){
    app=await createNodeServer({databasePath:join(root,'test.sqlite'),assetsDirectory:root});
    await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  try{
    let origin=await start();
    assert.match(await fetch(origin).then(r=>r.text()),/movement test client/);
    const anonymous=await fetch(origin+'/api/state');
    assert.equal(anonymous.status,401);assert.match(anonymous.headers.get('content-type'),/json/);
    const spoof=await fetch(origin+'/api/state',{headers:{'oai-authenticated-user-id':'forged'}});assert.equal(spoof.status,401);
    assert.equal((await fetch(origin+'/api/health').then(r=>r.json())).storage,'sqlite');
    const user='u_runtime_test';
    const get=()=>fetch(origin+'/api/state',{headers:{'x-test-user-id':user}}).then(r=>r.json());
    const post=async(path,body)=>{
      const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-test-user-id':user,Origin:origin},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    };
    assert.equal((await get()).profile,null);
    await post('profile',{displayName:'Тестировщик',timeZone:'UTC'});
    const id=crypto.randomUUID(),event={id,occurredAt:new Date().toISOString()};
    await post('repetitions',{events:[event]});await post('repetitions',{events:[event]});
    assert.equal((await get()).today.count,1);
    const proxy=await fetch(origin+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json','x-test-user-id':user,'x-forwarded-proto':'https',Origin:origin.replace('http:','https:')},body:JSON.stringify({displayName:'Тестировщик',timeZone:'UTC'})});
    assert.equal(proxy.status,200);
    const forbidden=await fetch(origin+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json','x-test-user-id':user,Origin:'https://other.test'},body:'{}'});assert.equal(forbidden.status,403);
    const unknown=await fetch(origin+'/api/unknown',{headers:{'x-test-user-id':user}});assert.equal(unknown.status,404);assert.match(unknown.headers.get('content-type'),/json/);
    await app.close();app=null;origin=await start();
    const restored=await get();assert.equal(restored.profile.displayName,'Тестировщик');assert.equal(restored.today.count,1);
    assert.equal((await fetch(origin+'/api/state',{headers:{'x-test-user-id':'u_another'}}).then(r=>r.json())).profile,null);
  }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});
