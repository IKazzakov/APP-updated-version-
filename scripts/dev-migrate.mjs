// Deliberately local-only: hosted migrations are applied by Sites on publish.
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const config=resolve(root,'dist/server/wrangler.json');
try{await access(config);}catch{throw new Error('Сначала выполните npm run build: нужен конфигурационный файл локального Worker.');}
const child=spawn(process.execPath,[
  resolve(root,'node_modules/wrangler/bin/wrangler.js'),
  'd1','migrations','apply','DB','--local',
  '--config',config,'--persist-to',resolve(root,'.wrangler/state'),
],{
  cwd:root,
  stdio:'inherit',
  env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(root,'.wrangler/logs'),CLOUDFLARE_CF_FETCH_ENABLED:'false'},
});
child.on('error',()=>{process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
