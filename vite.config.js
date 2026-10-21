import {defineConfig} from 'vite';
import {sites} from '@openai/sites-vite-plugin';
import {readFileSync} from 'node:fs';

const hosting=JSON.parse(readFileSync(new URL('./.openai/hosting.json',import.meta.url),'utf8'));

export default defineConfig(async()=>{
  // Keep disposable preview state inside the checkout. These are tool settings,
  // never application secrets. The hosted DB is provisioned by Sites.
  process.env.WRANGLER_SEND_METRICS??='false';
  process.env.WRANGLER_WRITE_LOGS??='false';
  process.env.WRANGLER_LOG_PATH??='.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH??='.wrangler/registry';
  process.env.CLOUDFLARE_CF_FETCH_ENABLED??='false';
  const {cloudflare}=await import('@cloudflare/vite-plugin');
  return {
    server:{host:'127.0.0.1'},
    preview:{host:'127.0.0.1'},
    plugins:[
      sites(),
      cloudflare({
        viteEnvironment:{name:'server'},
        persistState:{path:'.wrangler/state'},
        inspectorPort:false,
        remoteBindings:false,
        config:{
          name:'exercise-counter-mvp',
          main:'./server/worker.js',
          compatibility_date:'2026-05-15',
          compatibility_flags:['nodejs_compat'],
          assets:{binding:'ASSETS',run_worker_first:true},
          d1_databases:hosting.d1?[{
            binding:hosting.d1,
            database_name:'exercise-counter-local',
            // Official Sites starter placeholder; used only by local previews.
            database_id:'00000000-0000-4000-8000-000000000000',
            // Wrangler reads this from dist/server/wrangler.json; sites()
            // packages migration SQL alongside it under dist/.openai/drizzle.
            migrations_dir:'../.openai/drizzle',
          }]:[],
        },
      }),
    ],
  };
});
