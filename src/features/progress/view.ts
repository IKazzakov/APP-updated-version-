import { resultComparison } from '../../shared/progress.ts';
import { dom, escape, dateLabel as formatDate } from '../../shared/dom.ts';
import type { FeatureContext } from '../../shared/feature.ts';
import { RULES_VERSION } from '../../config.js';
import { comparableRounds } from '../../progress.js';
import { summaryHTML, periodLabel } from '../../shared/weekly.ts';
import { bindSummaryActions } from '../../shared/summary-actions.ts';
export function createProgress(root: HTMLElement, ctx: FeatureContext) {
  const { get: $, text } = dom(root),
    { session } = ctx;
  const dateLabel = (value: number, options?: Intl.DateTimeFormatOptions) =>
    formatDate(value, session.state?.profile?.timeZone || 'UTC', options);
  const cleanup = bindSummaryActions(root, session, ctx.showError);
  function render() {
    const state = session.state;
    if (!state?.profile) return;
    const p = comparableRounds(state.rounds, RULES_VERSION);
    text('last-result', p.last?.count ?? '—');
    text('personal-record', state.stats?.record ?? p.record ?? '—');
    text('result-comparison', resultComparison(state));
    $('round-history').innerHTML = p.history.length
      ? p.history
          .map(
            (r) =>
              /* HTML */ `<div class="history-row">
                <div>
                  ${escape(
                    dateLabel(r.finishedAt || r.endsAt, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  )}<small
                    >${escape(
                      dateLabel(r.finishedAt || r.endsAt, { hour: '2-digit', minute: '2-digit' }),
                    )}</small
                  >
                </div>
                <span
                  >${r.kind === 'competition' ? 'Соревнование' : 'Личный раунд'}<small
                    >${escape(r.rulesVersion)}</small
                  ></span
                ><strong>${r.count}</strong>
              </div>`,
          )
          .join('')
      : '<p class="empty-state">Пока нет завершённых минутных раундов.<br>Попробуйте «Мой результат за 60 секунд».</p>';
    const history = [...p.history].reverse();
    if (!history.length) {
      $('progress-chart').innerHTML =
        '<p class="chart-empty">Здесь появятся ваши результаты. Первый раунд станет началом графика.</p>';
      return;
    }
    const rows = history.slice(-30),
      max = Math.max(10, ...rows.map((r) => r.count)),
      width = 680,
      height = 190;
    const points = rows.map((r, i) => ({
      x: rows.length === 1 ? width / 2 : 35 + (i * (width - 70)) / (rows.length - 1),
      y: 150 - (r.count / max) * 125,
      r,
    }));
    const line = points.map((p) => `${p.x},${p.y}`).join(' ');
    $('progress-chart').innerHTML = /* HTML */ `<svg
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Результаты последних ${rows.length} минутных раундов: ${rows
        .map((r) => r.count)
        .join(', ')}"
    >
      <path d="M35 150H645" stroke="#e1e8d7" />
      ${[0, max]
        .map(
          (n) =>
            /* HTML */ `<text x="8" y="${154 - (n / max) * 125}" font-size="10" fill="#94a184"
              >${n}</text
            >`,
        )
        .join('')}
      <polyline points="${line}" stroke="#89b350" stroke-width="3" fill="none" />
      ${points
        .map(
          (p) =>
            /* HTML */ `<circle cx="${p.x}" cy="${p.y}" r="5" fill="#83a94f"
              ><title>${escape(dateLabel(p.r.endsAt))}: ${p.r.count}</title></circle
            >`,
        )
        .join('')}
      <text x="35" y="180" font-size="11" fill="#94a184">${escape(dateLabel(rows[0].endsAt))}</text>
      <text x="645" y="180" text-anchor="end" font-size="11" fill="#94a184">
        ${escape(dateLabel(rows.at(-1)!.endsAt))}
      </text>
    </svg>`;
  }
  function update() {
    render();
    const summaries = session.state?.weekly?.summaries || [];
    $('weekly-history').innerHTML = summaries.length
      ? summaries
          .map(
            (s) =>
              /* HTML */ `<details class="week-history-row">
                <summary>
                  ${periodLabel(s.week)}
                  <strong>${s.points.total} баллов</strong>${s.updatedSinceSeen
                    ? '<span class="pill">Обновлено</span>'
                    : ''}
                </summary>
                <div>${summaryHTML(s, true)}</div>
              </details>`,
          )
          .join('')
      : '<p class="empty-state">После первой недели здесь сохранятся ваши итоги.</p>';
    for (const [kind, id] of [
      ['rounds', 'history-more'],
      ['weeks', 'weeks-more'],
    ] as const) {
      const p = session.pageInfo(kind);
      $(id).hidden = !session.client.compact || !p.next;
      $(id).disabled = !!p.loading;
    }
  }
  $('history-more').onclick = () => void session.loadHistory('rounds', { more: true });
  $('weeks-more').onclick = () => void session.loadHistory('weeks', { more: true });
  return {
    root,
    render: update,
    activate: () => {
      void session.loadHistory('rounds');
      void session.loadHistory('weeks');
    },
    destroy: cleanup,
  };
}
