export function selectReport(field){
  field.focus({preventScroll:true});field.select();field.setSelectionRange(0,field.value.length);
}

export async function copyReport(field){
  // Keep the exact report visible and stable even after successful copying.
  // Mobile users can always select it themselves if the browser blocks access.
  selectReport(field);
  try{
    if(!navigator.clipboard?.writeText)throw new Error('Clipboard API недоступен');
    await navigator.clipboard.writeText(field.value);return true;
  }catch{
    try{selectReport(field);return document.execCommand('copy')===true;}
    catch{return false;}
  }
}
