import { dom, escape } from '../../shared/dom.ts';
import type { FeatureContext } from '../../shared/feature.ts';
import { periodLabel, breakdown, summaryHTML } from '../../shared/weekly.ts';
import { bindSummaryActions } from '../../shared/summary-actions.ts';
import { createWorkoutOverview } from '../workouts/overview.ts';
export function createToday(root: HTMLElement, ctx: FeatureContext) {
  const { get: $, text } = dom(root),
    { session } = ctx;
  let calendarOffset = 0,
    lastBonus: number | null = null;
  const cleanup = bindSummaryActions(root, session, ctx.showError);
  const workouts = createWorkoutOverview(root, ctx);
  async function loadCalendar() {
    const state = session.state;
    if (!state?.today) return;
    const [year, month] = state.today.date.split('-').map(Number),
      first = new Date(Date.UTC(year, month - 1 + calendarOffset, 1)),
      last = new Date(Date.UTC(year, month + calendarOffset, 0));
    await session.loadHistory('progress', {
      from: first.toISOString().slice(0, 10),
      to: last.toISOString().slice(0, 10),
    });
  }
  function renderCalendar() {
    const state = session.state;
    if (!state?.today) return;
    const [year, month] = state.today.date.split('-').map(Number),
      cursor = new Date(Date.UTC(year, month - 1 + calendarOffset, 1));
    text(
      'calendar-month',
      new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        cursor,
      ),
    );
    $('month-next').disabled = calendarOffset >= 0;
    const map = new Map(state.days.map((d) => [d.date, d]));
    const prefix = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-`;
    const offset = (cursor.getUTCDay() + 6) % 7,
      total = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
    let html = '<span aria-hidden="true"></span>'.repeat(offset);
    for (let day = 1; day <= total; day++) {
      const date = prefix + String(day).padStart(2, '0'),
        row = map.get(date),
        completed = !!row?.completed;
      html += /* HTML */ `<div
        class="calendar-day ${completed ? 'complete ' : ''}${date === state.today.date
          ? 'today '
          : ''}${date > state.today.date ? 'future' : ''}"
        aria-label="${escape(date)}: ${completed
          ? 'задание выполнено'
          : `${row?.count || 0} приседаний`}"
        ${date === state.today.date ? 'aria-current="date"' : ''}
      >
        ${day}
      </div>`;
    }
    $('calendar').innerHTML = html;
  }
  function render() {
    workouts.render();
    const state = session.state,
      s = state;
    if (!s?.profile || !s.today || !s.weekly) return;
    text(
      'today-date',
      new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'long',
        weekday: 'long',
        timeZone: 'UTC',
      }).format(new Date(`${s.today.date}T12:00:00Z`)),
    );
    text('daily-number', s.today.count);
    $('daily-bar').value = Math.min(10, s.today.count);
    text(
      'daily-label',
      s.today.completed ? 'Задание выполнено · +10 баллов' : `Сегодня ${s.today.count} из 10`,
    );
    text(
      'daily-description',
      s.today.completed
        ? 'Награда за сегодня уже начислена. Двигайтесь дальше в своём темпе.'
        : 'Можно за несколько подходов. Все засчитанные приседания идут в дневное задание.',
    );
    text('regularity-points', s.points);
    text('last-seven', `${s.last7} из 7`);

    renderCalendar();
    const w = s.weekly,
      local = w.yourWeek,
      sync = session.sync;
    text('your-week-period', periodLabel(local.week));
    text('your-week-zone', `Календарная неделя · ${s.profile.timeZone}`);
    $('week-checks').innerHTML = local.dates
      .map(
        (d, i) =>
          /* HTML */ `<div
            class="week-check ${d.completed ? 'complete' : ''} ${d.today ? 'today' : ''}"
            aria-label="${escape(d.date)}: ${d.completed
              ? 'выполнено'
              : d.past
                ? 'не подтверждено'
                : 'ещё не выполнено'}"
          >
            <span>${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][i]}</span
            ><strong>${d.completed ? '✓' : d.past ? '·' : '—'}</strong>
          </div>`,
      )
      .join('');
    text('week-days', `Выполнено ${local.completedDays} из 7 дней календарной недели`);
    text(
      'week-bonus-status',
      local.points.fullWeek
        ? 'Полная неделя выполнена · +20 баллов'
        : sync.pending || sync.saving
          ? 'Ожидаем синхронизацию. Бонус появится после подтверждения всех семи дней.'
          : local.possible
            ? `Бонус +20: осталось выполнить дней — ${local.remaining}`
            : 'Есть пропущенный день. Новыми заданиями его не заменить. Ранее выполненное может подтвердиться после синхронизации.',
    );
    $('week-breakdown').innerHTML = breakdown(local.points);
    text(
      'week-sync-note',
      sync.pending || sync.saving || sync.error
        ? 'Есть неподтверждённые данные. Здесь показаны только сохранённые сервером баллы.'
        : 'Задания — по датам профиля; спортивный бонус — за рейтинг этой недели по UTC+2.',
    );
    text('places-period', `${periodLabel(w.sportsWeek)} · спортивная неделя UTC+2`);
    $('my-week-places').innerHTML = s.profile.rankingsEnabled
      ? (['result', 'points'] as const)
          .map((type) => {
            const r = w.places[type];
            return /* HTML */ `<button class="place-link" data-open-league="${type}">
              <span
                >${type === 'result' ? 'Результат' : 'Баллы'}<small
                  >${r
                    ? `${r.value} ${type === 'result' ? 'приседаний' : 'баллов'}`
                    : type === 'result'
                      ? 'Завершите личную минуту'
                      : 'Пока нет баллов'}</small
                ></span
              ><strong>${r ? `№ ${r.place}` : '—'} <span aria-hidden="true">↗</span></strong>
            </button>`;
          })
          .join('')
      : '<p>Вы отказались от участия в общих рейтингах. Изменить это можно в профиле.</p><button id="places-enable" class="button secondary">Настроить участие</button>';
    const unread = w.summaries.find((s) => !s.seen);
    $('weekly-recap').hidden = !unread;
    $('weekly-recap').innerHTML = unread ? summaryHTML(unread) : '';
    const totals = new Map(w.summaries.map((s) => [s.week, s.points.fullWeek + s.points.sport]));
    totals.set(local.week, local.points.fullWeek + local.points.sport);
    const bonus = s.bonusPoints ?? [...totals.values()].reduce((a, b) => a + b, 0);
    if (lastBonus !== null && bonus > lastBonus && !root.hidden) {
      $('bonus-notice').hidden = false;
      text('bonus-notice', `Получен недельный бонус: +${bonus - lastBonus} баллов`);
      $('your-week').classList.remove('bonus-earned');
      requestAnimationFrame(() => $('your-week').classList.add('bonus-earned'));
    }
    lastBonus = bonus;
  }
  $('month-prev').onclick = () => {
    calendarOffset--;
    render();
    void loadCalendar();
  };
  $('month-next').onclick = () => {
    calendarOffset = Math.min(0, calendarOffset + 1);
    render();
    void loadCalendar();
  };
  $('today-train').onclick = () => ctx.chooseMode('practice');
  const click = (e: Event) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-open-league],#places-enable');
    if (!b) return;
    if (b.id === 'places-enable') ctx.openProfile();
    else if (session.state?.weekly)
      ctx.openLeague(b.dataset.openLeague as 'result' | 'points', session.state.weekly.sportsWeek);
  };
  root.addEventListener('click', click);
  return {
    root,
    render,
    refresh: () => {
      void loadCalendar();
    },
    activate: () => {
      void loadCalendar();
    },
    destroy: () => {
      workouts.destroy();
      cleanup();
      root.removeEventListener('click', click);
    },
  };
}
