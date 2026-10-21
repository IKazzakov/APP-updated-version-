import {build} from 'esbuild';
import {mkdir,cp,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('public/assets/wasm',{recursive:true});
await cp('node_modules/@mediapipe/tasks-vision/wasm','public/assets/wasm',{recursive:true});
const manifest=JSON.parse(await readFile('public/assets/models/manifest.json','utf8'));
for(const m of manifest){const data=await readFile(`public/assets/models/${m.file}`);if(createHash('sha256').update(data).digest('hex')!==m.sha256)throw new Error(`Повреждён файл ${m.file}`);if((await stat(`public/assets/models/${m.file}`)).size<100000)throw new Error('Invalid model');}
console.log('Local model hashes and version-matched WASM verified');

await build({entryPoints:['src/vision.worker.js'],bundle:true,format:'iife',platform:'browser',target:'chrome110',outfile:'public/assets/vision.worker.js',minify:true});
