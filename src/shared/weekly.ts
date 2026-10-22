import { escape } from './dom.ts';
import type { Points, WeeklySummary } from './contracts/api.ts';
export const dateLabel = (date: string, year = false) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
export const periodLabel = (week: string) => {
  const end = new Date(Date.parse(`${week}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  return `${dateLabel(week)} — ${dateLabel(end, true)}`;
};
export const breakdown = (p: Points) =>
  /* HTML */ `<div><span>Задания</span><strong>${p.daily}</strong></div>
    <div><span>Полная неделя</span><strong>${p.fullWeek ? '+' : ''}${p.fullWeek}</strong></div>
    <div><span>Спортивное место</span><strong>${p.sport ? '+' : ''}${p.sport}</strong></div>
    <div class="points-total"><span>Всего за неделю</span><strong>${p.total}</strong></div>`;
export function summaryHTML(s: WeeklySummary, compact = false) {
  return /* HTML */ `<div class="card-top">
      <h2>Итоги · ${periodLabel(s.week)}</h2>
      ${s.updatedSinceSeen ? '<span class="pill">Сумма обновлена</span>' : ''}
    </div>
    <p>
      Выполнено дней: ${s.completedDays} из 7 · лучший результат:
      ${s.best ?? '—'}${s.best !== null ? ' за 60 секунд' : ''}<br />${s.participated
        ? s.place
          ? `Спортивное место: ${s.place}`
          : 'Участие без завершённого результата'
        : 'Без участия в спортивном рейтинге'}
      · ${escape(s.rulesVersion)}
    </p>
    <div class="points-breakdown">${breakdown(s.points)}</div>
    ${s.pointsMayUpdate
      ? '<p class="muted">Баллы могут дополниться после синхронизации заданий. Спортивный итог сохранён.</p>'
      : ''}${!s.seen || s.updatedSinceSeen
      ? /* HTML */ `<button
          class="button secondary"
          data-seen-week="${s.week}"
          data-seen-total="${s.points.total}"
        >
          ${compact ? 'Отметить просмотренным' : 'Понятно, сохранить в истории'}
        </button>`
      : ''}`;
}
