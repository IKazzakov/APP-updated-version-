import test from 'node:test';
import assert from 'node:assert/strict';
import {api,getConnectionDiagnostic} from '../src/api.js';

test('API diagnostics distinguish missing endpoint, HTML login, HTTP denial and transport errors without recording response bodies', async()=>{
  const original=globalThis.fetch;
  try{
    for(const [status,body,code] of [[404,'<html>not found</html>','API_NOT_FOUND'],[200,'<html>private sign-in token</html>','API_RESPONSE_INVALID'],[200,'{"unrelated":true}','API_RESPONSE_INVALID'],[403,'{"error":{"code":"FORBIDDEN"}}','FORBIDDEN']]){
      globalThis.fetch=async()=>new Response(body,{status});
      await assert.rejects(api('state'),e=>e.code===code&&e.status===status);
      assert.deepEqual(getConnectionDiagnostic(),{status,code});
      assert.equal(JSON.stringify(getConnectionDiagnostic()).includes('private'),false);
    }
    globalThis.fetch=async()=>{throw new TypeError('fetch failed with private detail');};
    await assert.rejects(api('state'),e=>e.code==='NETWORK');
    assert.deepEqual(getConnectionDiagnostic(),{status:null,code:'NETWORK'});
    globalThis.fetch=async()=>new Response(JSON.stringify({profile:null,serverNow:Date.now(),days:[],rounds:[],competitions:[]}));
    await api('state');assert.deepEqual(getConnectionDiagnostic(),{status:200,code:'OK'});
  }finally{globalThis.fetch=original;}
});
