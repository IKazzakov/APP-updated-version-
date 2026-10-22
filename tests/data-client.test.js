import test from 'node:test';
import assert from 'node:assert/strict';
import {createDataClient,mergeState} from '../src/data-client.js';
import {HistoryLoader} from '../src/history.js';
import {ApiError} from '../src/api.js';
test('new API is negotiated once; old servers retain their original routes without hiding network errors',async()=>{
  const calls=[],client=createDataClient(async path=>{calls.push(path);if(path.startsWith('v2/'))throw new ApiError('NOT_FOUND',404);return {ok:true};});
  await client.request('state');await client.request('repetitions');assert.deepEqual(calls,['v2/dashboard','state','repetitions']);assert.equal(client.compact,false);
  const failed=createDataClient(async()=>{throw new ApiError('NETWORK');});await assert.rejects(failed.request('state'),e=>e.code==='NETWORK');
});
test('partial receipts preserve loaded pages and an older revision cannot undo confirmed progress',()=>{
  const old={profile:{id:'a'},version:9,days:[{date:'2026-01-01',count:10}],rounds:[{id:'r',finishedAt:1}],competitions:[{id:'c'}],today:{count:2},weekly:{summaries:[{week:'2026-01-01'}],periods:[]}};
  const next=mergeState(old,{profile:{id:'a'},partial:true,version:10,today:{count:3},days:[{date:'2026-01-02',count:3}]});assert.equal(next.today.count,3);assert.equal(next.days.length,2);assert.equal(next.rounds.length,1);assert.equal(next.competitions.length,1);
  assert.equal(mergeState(next,{profile:{id:'a'},version:9,today:{count:1}}),next);
  assert.equal(mergeState(next,{profile:{id:'b'},version:0}).profile.id,'b');
});
test('a page response from the previous account never reaches the current screen',async()=>{
  let finish;const pages=[],h=new HistoryLoader({api:()=>new Promise(r=>finish=r),onPage:(...p)=>pages.push(p),onError:()=>{}});h.setOwner('a');const p=h.load('rounds');h.setOwner('b');finish({items:[{id:'private-a'}],nextCursor:null});await p;assert.deepEqual(pages,[]);
});
test('changing a calendar month while a request is pending eventually fetches the selected month',async()=>{
  let finish;const paths=[],h=new HistoryLoader({api:path=>{paths.push(path);return paths.length===1?new Promise(r=>finish=r):Promise.resolve({items:[],nextCursor:null});},onPage:()=>{},onError:error=>{throw error;}});
  h.setOwner('a');const first=h.load('progress',{from:'2026-10-01',to:'2026-10-31'}),second=h.load('progress',{from:'2026-09-01',to:'2026-09-30'});
  finish({items:[],nextCursor:null});await Promise.all([first,second]);assert.equal(paths.length,2);assert.ok(paths[1].includes('from=2026-09-01'));
});
