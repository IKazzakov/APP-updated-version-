// Application-wide technical activity. Raw URLs, payloads and error messages
// cannot enter this journal. It lives only in this tab/installation's memory.
export const ACTIVITY_LIMIT=300;
const events=new Set(['app.ready','ui.action','ui.tab','app.visibility','app.online','app.offline','app.error','request.start','request.end','request.error','queue.saved','queue.sending','queue.confirmed','queue.error','training.changed','round.start','round.end','auth.login','auth.logout','server.check','server.changed','report.copied','journal.cleared','model.loading','model.ready','model.error']);
const actions=new Set(['profile-toggle','profile-form','sign-out-btn','test-login-form','quick-guest-btn','today-train','practice-mode','personal-mode','start','pause','reset','stop','early-stop','switch-camera','cancel-preparation','sound-enabled','test-sound','show-points','month-prev','month-next','create-challenge','refresh-challenges','cancel-created-challenge','accept-challenge','copy-invite','retry-sync','retry-round','check-server','server-form','copy','select-report','refresh-league','league-personal','league-profile','points-week','points-all','league-week','history-more','competitions-more','weeks-more','training','today','regularity','competitions','progress','duels','result','points','attempt','invite','cancel','seen-week','diagnostics','clear-activity']);
const routes=new Set(['state','dashboard','repetitions','profile','rounds.start','rounds.finish','rounds.abort','competitions','competitions.cancel','invitations.preview','invitations.accept','leaderboards','weeks.seen','history.rounds','history.progress','history.weeks','auth.guest','auth.logout','health','other']);
const codes=new Set(('OK NETWORK TIMEOUT AUTH_REQUIRED SIGN_IN_REQUIRED DEVICE_AUTH_REQUIRED SESSION_REVOKED RATE_LIMITED FORBIDDEN STORAGE_UNAVAILABLE API_NOT_FOUND API_RESPONSE_INVALID ORIGIN_FORBIDDEN SERVER_ERROR LOCAL_STORAGE OUTBOX_CONFLICT INVALID_EVENT_TIME INVALID_ROUND_TIME ROUND_INTERRUPTED ROUND_RUNNING ROUND_START_FAILED CAMERA_DENIED CAMERA_UNAVAILABLE MODEL_LOAD MODEL_RUNTIME ACTIVE_ROUND INVALID_INPUT PROFILE_REQUIRED INCOMPATIBLE_RULES NOT_FOUND INVALID_ID INVALID_NAME INVALID_TIME_ZONE INVALID_EVENTS ROUND_NOT_FOUND REQUEST_REUSED COMPETITION_NOT_FOUND INVITATION_PENDING COMPETITION_CLOSING ATTEMPTS_EXHAUSTED START_CONFLICT INVALID_INVITATION INVITATION_TAKEN INVITATION_CANCELLED INVITATION_ACCEPTED SELF_INVITATION INVALID_REQUEST METHOD_NOT_ALLOWED JSON_REQUIRED INVALID_JSON TOO_LARGE INVALID_CURSOR INVALID_RANGE INVALID_LIMIT UNKNOWN_ERROR').split(' '));
const phases=new Set(['baseline','standing','descending','bottom']);
const statuses=new Set(['idle','preparing','running','completed','interrupted','loading','waiting','countdown','starting','error','requesting','confirmed','rejected','cancelled']);
export function activityRoute(path){
  const p=String(path).split('?')[0].replace(/^\/?api\//,'').replace(/^v2\//,'');
  if(/^rounds\/[^/]+\/(finish|abort)$/.test(p))return 'rounds.'+p.split('/')[2];
  if(/^competitions\/[^/]+\/cancel$/.test(p))return 'competitions.cancel';
  const route=p.replaceAll('/','.');return routes.has(route)?route:'other';
}
export class ActivityLog {
  constructor({limit=ACTIVITY_LIMIT,now=()=>new Date().toISOString()}={}){this.limit=Math.min(ACTIVITY_LIMIT,Math.max(1,limit));this.now=now;this.entries=[];this.listeners=new Set();this.sequence=0;}
  record(event,meta={}){
    if(!events.has(event))return;
    const data={};
    for(const key of ['status','ms','items','pending','bytes','revision'])if(Number.isFinite(meta[key])&&meta[key]>=0&&meta[key]<=1e12)data[key]=Math.round(meta[key]*10)/10;
    if(actions.has(meta.action))data.action=meta.action;
    if(routes.has(meta.route))data.route=meta.route;
    if(['GET','POST','HEAD'].includes(meta.method))data.method=meta.method;
    if(meta.code)data.code=codes.has(meta.code)?meta.code:'UNKNOWN_ERROR';
    if(['practice','personal','competition'].includes(meta.mode))data.mode=meta.mode;
    if(phases.has(meta.phase))data.phase=meta.phase;
    if(statuses.has(meta.stage))data.stage=meta.stage;
    for(const key of ['camera','ready','paused','hidden','local'])if(typeof meta[key]==='boolean')data[key]=meta[key];
    this.entries.push({sequence:++this.sequence,at:this.now(),event,...data});
    if(this.entries.length>this.limit)this.entries.splice(0,this.entries.length-this.limit);
    for(const listener of this.listeners){try{listener();}catch{/* Logging must never interrupt a workout. */}}
  }
  snapshot(){return this.entries.map(e=>({...e}));}
  subscribe(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  clear(){this.entries=[];this.record('journal.cleared');}
}
export const activity=new ActivityLog();
