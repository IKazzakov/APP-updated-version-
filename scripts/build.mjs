import {rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
// A static-to-Worker upgrade must not package obsolete output from an older
// build (including removed exercise assets). Only generated dist is cleared.
await rm('dist',{recursive:true,force:true});
for(const args of [['scripts/prepare-assets.mjs'],['node_modules/vite/bin/vite.js','build'],['scripts/build-validate.mjs']]){
 const result=spawnSync(process.execPath,args,{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status||1);
}
