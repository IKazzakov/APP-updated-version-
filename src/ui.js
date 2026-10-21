export const $=id=>document.getElementById(id);
export const names={squat:'Приседания',clap:'Хлопки ладонями'};
export const phases={baseline:'Исходное положение',standing:'Стоя',descending:'Опускание',bottom:'Нижнее положение / возврат',open:'Ладони разведены',approaching:'Сближение ладоней',closed:'Ладони сближены',reopening:'Повторное разведение'};
export function renderMode(mode){
  for(const key of ['squat','clap']){$(`mode-${key}`).classList.toggle('active',key===mode);$(`mode-${key}`).setAttribute('aria-pressed',String(key===mode));}
  $('counter-label').textContent=names[mode].toUpperCase();
  $('setup-text').textContent=mode==='squat'?'Поставьте телефон устойчиво в 2–3 метрах. Встаньте боком или немного под углом. Таз, колени и стопы должны быть видны.':'Поставьте телефон устойчиво примерно в 1–1,5 метрах. Встаньте лицом к камере, руки перед грудью. Сначала покажите разведённые ладони, затем хлопайте без остановок. Оставьте в кадре запас для движения рук.';
  $('mode-note').textContent=mode==='squat'?'Считаем полный цикл: вниз и снова вверх.':'Считаем движение ладоней, звук не используется. Скорость камеры подбирается автоматически.';
}
export function renderCount(count,bump=false){$('count').textContent=count;$('count').setAttribute('aria-label',`Повторений: ${count}`);if(bump){$('count').classList.remove('bump');void $('count').offsetWidth;$('count').classList.add('bump');}}
export function renderState(state,hint){$('state').textContent=state;$('hint').textContent=hint;}
export function renderDiagnostics(diag){
  const d=diag.snapshot(),rows=[['Приложение',`${d.version} · MediaPipe ${d.vision}`],['Упражнение',d.exercise],['Модель',d.model],['Статус модели',d.modelStatus],['Камера',d.camera],['Видеопоток',d.resolution],['Обработка',`${d.fps} кадров/с · ${d.inferenceMs??0} мс/кадр · ${d.delegate||'—'} / Worker`],['Счётчик',d.count],['Фаза',phases[d.phase]||d.phase],['Причина / подсказка',d.reason],['Измерения',JSON.stringify(d.metrics||{})],['Браузер',d.browser]];
  if(d.exercise===names.clap){
    const last=d.attempts.at(-1);
    const b=d.backendBenchmark;
    rows.splice(7,0,['Ускорение',d.backendStatus||'—'],['Замер CPU / GPU',b?.samples?`${b.cpuMs} / ${b.gpuMs} мс · ${b.samples} кадров`:'—'],['Резервный режим',d.fallbackReason||'Не потребовался'],['Вход модели',d.modelInput],['Распознано кистей',`${d.handsDetected??0} / 2`],['Отказ проверки',d.featureReason||'Нет'],['Последний отказ',d.lastRejection?.reason||'Нет'],['Последняя попытка',last?`№${last.id}: ${last.reason}`:'Ещё нет'],['Сохранено попыток',`${d.attempts.length} / 12`]);
    rows.splice(7,0,['Автопрофиль',d.autoProfile?.camera?.id||'—'],['Доставка камеры',`${d.cameraDeliveredFps??0} кадров/с`],['Источник движения',d.trackingSource],['Быстрый трекер',d.motion?`${d.motion.fps} кадров/с · ${d.motion.ms} мс · ${d.motion.input}`:'—'],['Согласование кадров',d.motion?.fusionDelayMs!=null?`${d.motion.fusionDelayMs} мс · ${d.motion.source}`:'—'],['Модель: целевая частота',`${d.autoProfile?.activeNeuralLimitFps??d.autoProfile?.neuralTargetFps??0} кадров/с`],['Автонастройка',d.autoProfile?.reason],['Кисти: оптический трекер / восстановление моделью',d.motion?`${d.motion.opticalValidFrames??0} / ${d.motion.modelRepairedFrames??0} из ${d.motion.frames} кадров`:'—'],['Резерв трекера',d.motionFallback||'Не потребовался']);
  }
  const dl=$('diag-values');dl.replaceChildren();for(const [key,value]of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value??'—';dl.append(dt,dd);}
  $('diag-log').textContent=JSON.stringify({attempts:d.attempts,currentAttempt:d.currentAttempt,errors:d.errors,events:d.log,rejections:d.rejections,recentTracking:d.trackingHistory.slice(-12)},null,2);
}
