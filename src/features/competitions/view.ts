import { escape } from '../../shared/dom.ts';
import { RULES_VERSION } from '../../config.js';
import type { Competition, Participant, Leaderboard } from '../../shared/contracts/api.ts';
const statuses: Record<Competition['status'], string> = {
  invited: 'Ждёт друга',
  active: 'Предварительные результаты',
  settling: 'Завершаем последние попытки',
  finished: 'Итог',
  cancelled: 'Вызов отменён',
};
function player(p: Participant | undefined, status: Competition['status']) {
  return /* HTML */ `<div class="player">
    <strong
      >${p
        ? escape(p.name) + (p.isYou ? ' · вы' : '')
        : status === 'cancelled'
          ? 'Без участника'
          : 'Ждём друга'}</strong
    >
    <div class="score">${p?.best ?? '—'}</div>
    <p>
      ${p
        ? `Осталось попыток: ${p.attemptsLeft} из 3`
        : status === 'cancelled'
          ? 'Приглашение недействительно'
          : 'Откроет ссылку и примет вызов'}
    </p>
    ${p?.activeAttempt ? '<p>Попытка идёт</p>' : ''}
  </div>`;
}
export function competitionHTML(
  c: Competition,
  hasInvite: boolean,
  dateLabel: (time: number, options?: Intl.DateTimeFormatOptions) => string,
) {
  const winner = c.participants.find((p) => p.role === c.result?.winner);
  const result = c.result
    ? c.result.type === 'not_held'
      ? 'Не состоялось'
      : c.result.type === 'tie'
        ? 'Ничья'
        : `Победа: ${winner?.name || 'участник'}`
    : '';
  return /* HTML */ `<article class="card competition-card">
    <div class="card-top">
      <strong>До 60 секунд · до трёх попыток</strong><span class="pill">${statuses[c.status]}</span>
    </div>
    <div class="competition-players">
      ${(['creator', 'opponent'] as const)
        .map((role) =>
          player(
            c.participants.find((p) => p.role === role),
            c.status,
          ),
        )
        .join('')}
    </div>
    <p>
      ${c.status === 'cancelled'
        ? 'Приглашение больше не действует. Попытки не израсходованы.'
        : c.expiresAt
          ? `До ${escape(dateLabel(c.expiresAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}`
          : '24 часа начнутся после принятия приглашения'}
      · ${escape(c.rulesVersion)}
    </p>
    ${result ? `<p class="competition-result">${escape(result)}</p>` : ''}
    ${c.canStart
      ? `<button class="button primary" data-attempt="${escape(c.id)}">Подготовить попытку</button>`
      : ''}
    ${hasInvite && c.status === 'invited'
      ? `<button class="button secondary" data-invite="${escape(c.id)}">Показать ссылку другу</button>`
      : ''}
    ${c.canCancel
      ? `<button class="button secondary" data-cancel-challenge="${escape(c.id)}">Отменить вызов</button><p class="muted">Можно отменить, пока друг не принял приглашение.</p>`
      : ''}
    ${c.rulesVersion !== RULES_VERSION
      ? '<p>Другая версия правил. Обновите приложение для участия.</p>'
      : ''}
  </article>`;
}
export function leaderboardHTML(b: Leaderboard, type: string) {
  if (!b.entries.length)
    return '<div class="empty-state">Пока нет участников с подтверждёнными показателями за этот период.</div>';
  const rows = b.entries
    .map(
      (e) =>
        /* HTML */ `<tr class="${e.isYou ? 'is-you' : ''}">
          <td>${e.place}</td>
          <th scope="row">
            ${escape(e.name)}${e.isYou ? '<span class="you-label">Вы</span>' : ''}
          </th>
          <td>${e.value}</td>
        </tr>`,
    )
    .join('');
  return /* HTML */ `<div class="league-table-wrap">
      <table class="league-table">
        <thead>
          <tr>
            <th scope="col">Место</th>
            <th scope="col">Имя</th>
            <th scope="col">${type === 'result' ? 'За 60 с' : 'Баллы'}</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    ${b.totalParticipants > 200 ? '<p class="muted">Показаны первые 200 участников.</p>' : ''}
    ${b.you && !b.entries.some((e) => e.isYou)
      ? `<p>Ваше место: ${b.you.place} · ${b.you.value}</p>`
      : ''}`;
}
