const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel=(date,year=false)=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',...(year?{year:'numeric'}:{}),timeZone:'UTC'}).format(new Date(`${date}T12:00:00Z`));
const periodLabel=week=>{const end=new Date(Date.parse(`${week}T12:00:00Z`)+6*86400000).toISOString().slice(0,10);return `${dateLabel(week)} — ${dateLabel(end,true)}`;};
const breakdown=p=>`<div><span>Задания</span><strong>${p.daily}</strong></div><div><span>Полная неделя</span><strong>${p.fullWeek?'+':''}${p.fullWeek}</strong></div><div><span>Спортивное место</span><strong>${p.sport?'+':''}${p.sport}</strong></div><div class="points-total"><span>Всего за неделю</span><strong>${p.total}</strong></div>`;

export class WeeklyUI {
  constructor({api,onState,onError,onPersonal,onProfile,onCompetitions}) {
    Object.assign(this,{api,onState,onError,onPersonal,onProfile,onCompetitions});
    this.tab='duels';this.period='week';this.week=null;this.state=null;this.generation=0;this.lastBonus=null;this.pending=null;this.dataKey=null;this.boardKey=null;
    for(const b of document.querySelectorAll('[data-competition-tab]'))b.onclick=()=>this.open(b.dataset.competitionTab);
    // Arrow keys keep the inner tabs usable from a keyboard as well as touch.
    for(const b of document.querySelectorAll('[data-competition-tab]'))b.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const names=['duels','result','points'];let i=names.indexOf(this.tab);i=e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3;this.open(names[i]);$(`competition-tab-${names[i]}`).focus();};
    $('league-week').onchange=()=>{this.week=$('league-week').value;this.load();};
    $('points-week').onclick=()=>{this.period='week';this.load();};
    $('points-all').onclick=()=>{this.period='all';this.load();};
    $('refresh-league').onclick=()=>this.load();
    $('league-personal').onclick=onPersonal;$('league-profile').onclick=onProfile;
    this.timer=setInterval(()=>this.renderDeadline(),1000);
  }
  open(tab) {
    if(!['duels','result','points'].includes(tab))return;
    this.tab=tab;
    if(tab==='duels'){this.generation++;this.pending=null;}
    for(const b of document.querySelectorAll('[data-competition-tab]')){const active=b.dataset.competitionTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}
    $('competition-duels').hidden=tab!=='duels';$('league-panel').hidden=tab==='duels';
    $('league-panel').setAttribute('aria-labelledby',`competition-tab-${tab}`);
    if(tab!=='duels')this.load();
  }
  activate(){if(this.tab!=='duels')this.load({quiet:true});}
  render(state,sync={},training=false) {
    this.state=state;this.training=training;
    const w=state?.weekly;if(!w)return;
    this.serverAtReceipt={now:state.serverNow,received:performance.now()};
    const local=w.yourWeek;
    $('your-week-period').textContent=periodLabel(local.week);
    $('your-week-zone').textContent=`Календарная неделя · ${state.profile.timeZone}`;
    $('week-checks').innerHTML=local.dates.map((d,i)=>`<div class="week-check ${d.completed?'complete':''} ${d.today?'today':''}" aria-label="${escape(d.date)}: ${d.completed?'выполнено':d.past?'не подтверждено':'ещё не выполнено'}"><span>${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][i]}</span><strong>${d.completed?'✓':d.past?'·':'—'}</strong></div>`).join('');
    $('week-days').textContent=`Выполнено ${local.completedDays} из 7 дней календарной недели`;
    $('week-bonus-status').textContent=local.points.fullWeek?'Полная неделя выполнена · +20 баллов':sync.pending||sync.saving?'Ожидаем синхронизацию. Бонус появится после подтверждения всех семи дней.':local.possible?`Бонус +20: осталось выполнить дней — ${local.remaining}`:'Есть пропущенный день. Новыми заданиями его не заменить. Ранее выполненное может подтвердиться после синхронизации.';
    $('week-breakdown').innerHTML=breakdown(local.points);
    $('week-sync-note').textContent=sync.pending||sync.saving||sync.error?'Есть неподтверждённые данные. Здесь показаны только сохранённые сервером баллы.':'Задания — по датам профиля; спортивный бонус — за рейтинг этой недели по UTC+2.';
    $('places-period').textContent=`${periodLabel(w.sportsWeek)} · спортивная неделя UTC+2`;
    $('my-week-places').innerHTML=state.profile.rankingsEnabled?['result','points'].map(type=>{const r=w.places[type];return `<button class="place-link" data-open-league="${type}"><span>${type==='result'?'Результат':'Баллы'}<small>${r?`${r.value} ${type==='result'?'приседаний':'баллов'}`:type==='result'?'Завершите личную минуту':'Пока нет баллов'}</small></span><strong>${r?`№ ${r.place}`:'—'} <span aria-hidden="true">↗</span></strong></button>`;}).join(''):'<p>Вы отказались от участия в общих рейтингах. Изменить это можно в профиле.</p><button id="places-enable" class="button secondary">Настроить участие</button>';
    $('places-enable')?.addEventListener('click',this.onProfile);
    for(const b of document.querySelectorAll('[data-open-league]'))b.onclick=()=>{this.week=w.sportsWeek;this.period='week';this.onCompetitions();this.open(b.dataset.openLeague);};
    const options=w.periods.map(p=>`<option value="${p.week}">${periodLabel(p.week)}${p.closed?' · итоги':' · текущая'}</option>`).join('');
    if($('league-week').innerHTML!==options)$('league-week').innerHTML=options;
    if(!w.periods.some(p=>p.week===this.week))this.week=w.sportsWeek;
    $('league-week').value=this.week;
    this.renderSummaries(w.summaries,training);
    const totals=new Map(w.summaries.map(s=>[s.week,s.points.fullWeek+s.points.sport]));totals.set(local.week,local.points.fullWeek+local.points.sport);
    const bonus=Number.isFinite(state.bonusPoints)?state.bonusPoints:[...totals.values()].reduce((a,b)=>a+b,0);
    if(this.lastBonus!==null&&bonus>this.lastBonus&&!training){$('bonus-notice').hidden=false;$('bonus-notice').textContent=`Получен недельный бонус: +${bonus-this.lastBonus} баллов`;$('your-week').classList.remove('bonus-earned');requestAnimationFrame(()=>$('your-week').classList.add('bonus-earned'));}
    this.lastBonus=bonus;
    // Synchronization regularly renders identical state with a new serverNow.
    // Those renders must never clear/refetch the open table. Refresh quietly
    // only for relevant changed data; tabs/filters/manual refresh load explicitly.
    const key=JSON.stringify([state.profile,state.points,state.rounds,w.periods,w.summaries.map(s=>[s.week,s.revision])]);
    const changed=this.dataKey!==null&&this.dataKey!==key;
    this.dataKey=key;
    if(changed&&this.tab!=='duels'&&!$('tab-competitions').hidden)this.load({quiet:true});
  }
  summaryHTML(s,compact=false) {
    return `<div class="card-top"><h2>Итоги · ${periodLabel(s.week)}</h2>${s.updatedSinceSeen?'<span class="pill">Сумма обновлена</span>':''}</div><p>Выполнено дней: ${s.completedDays} из 7 · лучший результат: ${s.best??'—'}${s.best!==null?' за 60 секунд':''}<br>${s.participated?(s.place?`Спортивное место: ${s.place}`:'Участие без завершённого результата'):'Без участия в спортивном рейтинге'} · ${escape(s.rulesVersion)}</p><div class="points-breakdown">${breakdown(s.points)}</div>${s.pointsMayUpdate?'<p class="muted">Баллы могут дополниться после синхронизации заданий. Спортивный итог сохранён.</p>':''}${!s.seen||s.updatedSinceSeen?`<button class="button secondary" data-seen-week="${s.week}" data-seen-total="${s.points.total}">${compact?'Отметить просмотренным':'Понятно, сохранить в истории'}</button>`:''}`;
  }
  renderSummaries(summaries,training) {
    const unread=summaries.find(s=>!s.seen);
    $('weekly-recap').hidden=!unread||training;
    $('weekly-recap').innerHTML=unread?this.summaryHTML(unread):'';
    $('weekly-history').innerHTML=summaries.length?summaries.map(s=>`<details class="week-history-row"><summary>${periodLabel(s.week)} <strong>${s.points.total} баллов</strong>${s.updatedSinceSeen?'<span class="pill">Обновлено</span>':''}</summary><div>${this.summaryHTML(s,true)}</div></details>`).join(''):'<p class="empty-state">После первой недели здесь сохранятся ваши итоги.</p>';
    for(const button of document.querySelectorAll('[data-seen-week]'))button.onclick=async()=>{button.disabled=true;try{const r=await this.api('weeks/seen',{method:'POST',body:{week:button.dataset.seenWeek,total:Number(button.dataset.seenTotal)}});await this.onState(r.state);}catch(error){this.onError(error);button.disabled=false;}};
  }
  renderDeadline() {
    if(!this.board||this.tab==='duels'||$('tab-competitions').hidden)return;
    if(this.tab==='points'&&this.period==='all'){$('league-deadline').textContent='Все сохранённые дневные награды и недельные бонусы.';return;}
    if(this.board.periodInfo.closed){$('league-deadline').textContent='Спортивная неделя закрыта. Итоговые места сохранены.';return;}
    const clock=this.boardClock||this.serverAtReceipt,now=clock.now+performance.now()-clock.received;
    const seconds=Math.max(0,Math.ceil((this.board.periodInfo.endsAt-now)/1000));
    const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
    $('league-deadline').textContent=seconds?`До конца недели: ${days} д ${hours} ч ${minutes} мин · UTC+2`:'Неделя закончилась. Сервер подтверждает последние раунды и итог.';
  }
  async load({quiet=false}={}) {
    if(this.tab==='duels'||!this.state?.weekly)return;
    const type=this.tab,period=type==='result'?'week':this.period;
    const key=`${type}|${period}|${this.week}`,requestKey=key+'|'+this.dataKey;
    if(this.pending?.key===requestKey)return this.pending.promise;
    const generation=++this.generation,keep=!!this.board&&this.boardKey===key;
    $('league-title').textContent=type==='result'?'Лучшая минута недели':'Баллы за движение';
    $('points-periods').hidden=type!=='points';$('league-week-label').hidden=period==='all';
    for(const name of ['week','all']){$(`points-${name}`).classList.toggle('active',period===name);$(`points-${name}`).setAttribute('aria-pressed',String(period===name));}
    if(!keep){$('league-status').textContent='Загружаем подтверждённые данные…';$('league-table').innerHTML='';this.board=null;}
    else if(!quiet)$('league-status').textContent='Обновляем данные…';
    $('refresh-league').disabled=true;$('league-table').setAttribute('aria-busy','true');
    $('league-profile').hidden=this.state.profile.rankingsEnabled;
    $('league-consent').textContent=this.state.profile.rankingsEnabled?'Вы участвуете. Имя и показатели видны другим пользователям с доступом к APP.':'Участие выключено. Ваши данные скрыты из общих таблиц; личные баллы сохраняются.';
    if(!keep){$('league-personal').hidden=true;$('league-sync-note').textContent='';$('league-deadline').textContent='';}
    const promise=(async()=>{try {
      const b=await this.api(`leaderboards?type=${type}&period=${period}&week=${this.week}`);
      if(generation!==this.generation)return;
      this.board=b;this.boardKey=key;this.boardClock={now:b.serverNow,received:performance.now()};
      $('league-period').textContent=period==='all'?'Всё время':`${periodLabel(b.week)} · ${type==='result'?b.periodInfo.rulesVersion:'дневные награды и бонусы'}`;
      $('league-status').textContent=type==='result'?(b.periodInfo.closed?'Итоговые места':'Предварительные места'):'Места по баллам · без награды за место';
      $('league-table').innerHTML=b.entries.length?`<div class="league-table-wrap"><table class="league-table"><thead><tr><th scope="col">Место</th><th scope="col">Имя</th><th scope="col">${type==='result'?'За 60 с':'Баллы'}</th></tr></thead><tbody>${b.entries.map(e=>`<tr class="${e.isYou?'is-you':''}"><td>${e.place}</td><th scope="row">${escape(e.name)}${e.isYou?'<span class="you-label">Вы</span>':''}</th><td>${e.value}</td></tr>`).join('')}</tbody></table></div>${b.totalParticipants>200?'<p class="muted">Показаны первые 200 участников.</p>':''}${b.you&&!b.entries.some(e=>e.isYou)?`<p>Ваше место: ${b.you.place} · ${b.you.value}</p>`:''}`:'<div class="empty-state">Пока нет участников с подтверждёнными показателями за этот период.</div>';
      $('league-personal').hidden=type!=='result'||!!b.you||b.periodInfo.closed;
      $('league-sync-note').textContent=type==='points'&&b.pointsMayUpdate?`${period==='all'?'Баллы могут обновиться':'Баллы этой недели могут обновиться'} после синхронизации ранее выполненных заданий. Спортивные места после закрытия не меняются.`:type==='result'?'Один лучший завершённый раунд на участника. При равенстве — одинаковое место.':'';
      this.renderDeadline();
    } catch(error) {
      if(generation!==this.generation)return;
      $('league-status').textContent=keep?'Не удалось обновить рейтинг. Показаны предыдущие данные. Нажмите «Обновить».':'Не удалось загрузить рейтинг. Проверьте сеть и нажмите «Обновить».';
      if(!keep)$('league-table').innerHTML='<p class="empty-state">Данные не подтверждены. Сохранённый личный прогресс остаётся в вашем профиле.</p>';
    } finally {
      if(generation===this.generation){this.pending=null;$('refresh-league').disabled=false;$('league-table').setAttribute('aria-busy','false');}
    }})();
    this.pending={key:requestKey,promise};
    return promise;
  }
}
