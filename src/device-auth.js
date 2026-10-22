// Credentials are individual to this installation and API origin. They never
// enter the APK source, outbox, diagnostics or invitations.
const required=new Set();
const key=base=>`movement.device-session.${base==='/api'?(globalThis.location?.origin||'local'):base}`;
export function deviceSecret(base){
  try{const value=localStorage.getItem(key(base))||'';return /^[a-f0-9]{64}$/.test(value)?value:'';}catch{return '';}
}
export const usesDeviceAuth=base=>required.has(base)||!!deviceSecret(base);
export const requireDeviceAuth=base=>required.add(base);
export function newDeviceSecret(base){
  const secret=[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('');
  localStorage.setItem(key(base),secret);
  if(deviceSecret(base)!==secret)throw new Error('Device credential storage unavailable');
  return secret;
}
export const forgetDeviceSecret=base=>localStorage.removeItem(key(base));
