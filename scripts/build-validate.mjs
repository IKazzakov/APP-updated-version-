import assert from 'node:assert/strict';
import {readFile,stat,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const json=async file=>JSON.parse(await readFile(resolve(root,file),'utf8'));
const source=await json('.openai/hosting.json');
const packed=await json('dist/.openai/hosting.json');
assert.deepEqual(packed,source,'Sites manifest must match the source');
assert.equal(source.project_id,'appgprj_6ad62c5922ac8191ab25736e2b758aa2');
assert.equal(source.d1,'DB');
assert.equal(source.static,undefined,'Worker deployment must not retain static mode');
for(const file of ['dist/client/index.html','dist/server/index.js','dist/server/wrangler.json','dist/.openai/drizzle/meta/_journal.json']){
  assert.ok((await stat(resolve(root,file))).size>0,`Missing deployment file: ${file}`);
}
const runtime=await json('dist/server/wrangler.json');
assert.equal(runtime.assets.binding,'ASSETS');
assert.ok(runtime.d1_databases.some(db=>db.binding==='DB'));
const models=await json('public/assets/models/manifest.json');
assert.ok(models.some(model=>model.file==='pose_landmarker_full.task'));
assert.ok(!models.some(model=>/hand|lite/.test(model.file)),'MVP uses only Pose Full');
for(const model of models)assert.equal((await stat(resolve(root,'dist/client/assets/models',model.file))).size,(await stat(resolve(root,'public/assets/models',model.file))).size);
const wasm=await readdir(resolve(root,'dist/client/assets/wasm'));
assert.ok(wasm.some(file=>file.endsWith('.wasm')),'WASM must be hosted with the app');
const sql=(await readdir(resolve(root,'dist/.openai/drizzle'))).filter(file=>file.endsWith('.sql'));
assert.ok(sql.length>0,'The initial D1 schema must be packaged');
const worker=await readFile(resolve(root,'dist/server/index.js'),'utf8');
assert.ok(!worker.includes('local_seedy'),'Local sign-in must not appear in the production Worker');
assert.ok(!worker.includes('__sites_local_auth'),'Development cookies must not appear in the production Worker');
console.log('Sites Worker, private-data bindings, migrations, Pose Full and local WASM are packaged.');
