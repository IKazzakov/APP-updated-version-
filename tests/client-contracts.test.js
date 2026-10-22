import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './server-db.js';
import {handleApi} from '../server/api.js';
import {parseReply,isSnapshot} from '../src/shared/contracts/validate.ts';
import {AppStore} from '../src/app/store.ts';

test('client contracts accept real legacy and v2 responses, including a partial receipt',async t=>{
 const db=createTestDatabase();t.after(()=>db.close());const now=Date.parse('2026-10-20T12:00:00Z');
 const call=async(path,body)=>{const r=await handleApi(new Request('https://test.example/api/'+path,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':'alice',origin:'https://test.example','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db},{now:()=>now});assert.equal(r.status,200,path);return r.json();};
 parseReply('state',await call('state'));
 parseReply('profile',await call('v2/profile',{displayName:'Alice',timeZone:'UTC'}));
 const old=parseReply('state',await call('state')),dashboard=parseReply('state',await call('v2/dashboard'));
 const receipt=parseReply('repetitions',await call('v2/repetitions',{events:[{id:crypto.randomUUID(),occurredAt:now}]}));assert.equal(receipt.state.partial,true);
 for(const kind of ['rounds','progress','weeks'])parseReply('history/'+kind+'?limit=50',await call('v2/history/'+kind+'?limit=50'));
 parseReply('competitions?limit=50',await call('v2/competitions?limit=50'));
 parseReply('leaderboards?type=points',await call('v2/leaderboards?type=points'));
 const start=parseReply('rounds/start',await call('v2/rounds/start',{requestId:crypto.randomUUID(),kind:'personal'}));
 parseReply(`rounds/${start.round.id}/abort`,await call(`v2/rounds/${start.round.id}/abort`,{}));
 const competition=parseReply('competitions',await call('v2/competitions',{requestId:crypto.randomUUID(),token:'a'.repeat(64)}));assert.ok(competition.competition.id);
 parseReply('invitations/preview',await call('v2/invitations/preview',{token:'a'.repeat(64)}));
 assert.equal(isSnapshot({...dashboard,serverNow:'now'}),false);
 assert.equal(isSnapshot({...dashboard,rounds:[{id:'broken'}]}),false);
 assert.throws(()=>parseReply('state',{...dashboard,weekly:{}}),/API_RESPONSE_INVALID/);
 assert.throws(()=>parseReply('state',receipt.state),/API_RESPONSE_INVALID/);
 assert.equal(parseReply('state',{...old,newCompatibleField:123}).newCompatibleField,123);
});

test('store rejects stale session callbacks and keeps pages when a compact receipt arrives',async t=>{
 const db=createTestDatabase();t.after(()=>db.close());const now=Date.parse('2026-10-20T12:00:00Z');
 const call=async(path,body)=>{const r=await handleApi(new Request('https://test.example/api/'+path,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':'alice',origin:'https://test.example','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db},{now:()=>now});return r.json();};
 await call('v2/profile',{displayName:'Alice',timeZone:'UTC'});const initial=await call('v2/dashboard');
 const store=new AppStore();let notifications=0;const unsub=store.subscribe(()=>notifications++);store.apply(initial);const epoch=store.epoch;
 const item={id:'historical',kind:'personal',status:'completed',competitionId:null,rulesVersion:'squat-v1',startsAt:now-60000,endsAt:now,finishedAt:now,count:5};store.page('rounds',[item],false);const receipt=(await call('v2/repetitions',{events:[{id:crypto.randomUUID(),occurredAt:now}]})).state;
 store.apply(receipt);assert.equal(store.state.rounds[0].id,'historical');assert.equal(store.state.today.count,1);
 store.apply(initial);assert.equal(store.state.today.count,1);
 store.reset();assert.equal(store.apply(initial,epoch),false);store.page('rounds',[item],false,epoch);assert.equal(store.state,null);
 unsub();const count=notifications;store.apply(initial);assert.equal(notifications,count);
});
