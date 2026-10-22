import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityLog,activityRoute} from '../src/activity-log.js';
test('activity strips private payloads, raw error messages, arbitrary codes and identities from routes',()=>{
  const a=new ActivityLog();a.record('request.error',{route:activityRoute('v2/rounds/PRIVATE_ID/finish?token=PRIVATE_TOKEN'),code:'PRIVATE_NAME',status:500,body:{email:'PRIVATE_EMAIL'},message:'PRIVATE_SECRET',url:'https://PRIVATE_URL'});
  const text=JSON.stringify(a.snapshot());assert.equal(text.includes('PRIVATE'),false);assert.equal(a.snapshot()[0].route,'rounds.finish');assert.equal(a.snapshot()[0].code,'UNKNOWN_ERROR');
  a.record('ui.action',{action:'PRIVATE_NAME'});assert.equal('action' in a.snapshot()[1],false);
});
test('journal is bounded, has immutable snapshots, survives screen changes and notifies without breaking actions',()=>{
  const a=new ActivityLog({limit:3});a.subscribe(()=>{throw new Error('subscriber');});for(let i=0;i<8;i++)a.record('request.end',{status:200});
  const data=a.snapshot();assert.equal(data.length,3);data[0].status=500;assert.equal(a.snapshot()[0].status,200);a.record('ui.tab',{action:'training'});assert.equal(a.snapshot().at(-1).action,'training');a.clear();assert.equal(a.snapshot().length,1);
});
