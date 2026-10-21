// Locally synthesized tones: no audio files, microphone, recording or network.
export const SIGNALS=Object.freeze({
  ready:[[660,0,.10],[880,.13,.14]],
  countdown:[[520,0,.09]],
  start:[[880,0,.12],[1320,.14,.28]],
  end:[[660,0,.20],[440,.24,.20],[330,.48,.38]],
});
export class RoundSound {
  constructor({contextFactory=()=>new (globalThis.AudioContext||globalThis.webkitAudioContext)(),onChange=()=>{}}={}){this.contextFactory=contextFactory;this.onChange=onChange;this.enabled=true;this.context=null;this.nodes=new Set();this.available=false;}
  async unlock(){
    // Called synchronously from the Prepare/Test/enable click handler before
    // waiting for camera permissions, so Chrome grants audio activation.
    try{
      this.context??=this.contextFactory();
      const resumed=this.context.resume();
      await Promise.race([resumed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Audio unavailable')),1500);timer.unref?.();resumed.finally(()=>clearTimeout(timer)).catch(()=>{});})]);
      this.available=this.context.state==='running';
      this.onChange(this.available?'':'Звук недоступен. Проверьте громкость и нажмите «Проверить сигнал». Визуальный отсчёт продолжит работать.');return this.available;
    }catch{this.available=false;this.onChange('Звук недоступен в этом браузере. Используйте визуальный отсчёт или откройте приложение в Chrome.');return false;}
  }
  setEnabled(value){this.enabled=!!value;if(!this.enabled)this.stop();}
  stop(){for(const node of this.nodes){try{node.stop();}catch{}}this.nodes.clear();}
  play(kind){
    if(!this.enabled)return false;
    if(!this.context||this.context.state!=='running'){this.available=false;this.onChange('Браузер приостановил звук. Нажмите «Проверить сигнал» перед подготовкой.');return false;}
    const tones=SIGNALS[kind];if(!tones)return false;
    const offset=kind==='countdown'?0.33:0; // ready phrase precedes the first tick
    try{
      for(const [frequency,delay,duration] of tones){
        const oscillator=this.context.createOscillator(),gain=this.context.createGain(),at=this.context.currentTime+delay+offset;
        oscillator.type='sine';oscillator.frequency.value=frequency;
        gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.24,at+.012);gain.gain.setValueAtTime(.24,at+duration-.025);gain.gain.linearRampToValueAtTime(0,at+duration);
        oscillator.connect(gain);gain.connect(this.context.destination);this.nodes.add(oscillator);
        oscillator.onended=()=>{this.nodes.delete(oscillator);oscillator.disconnect();gain.disconnect();};
        oscillator.start(at);oscillator.stop(at+duration+.01);
      }
      return true;
    }catch{this.available=false;this.onChange('Не удалось воспроизвести сигнал. Визуальные подсказки работают.');return false;}
  }
}
