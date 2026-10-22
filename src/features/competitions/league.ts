import { leaderboardHTML } from './view.ts';
import { dom } from '../../shared/dom.ts';
import { periodLabel } from '../../shared/weekly.ts';
import type { FeatureContext } from '../../shared/feature.ts';
import type { AppState, Leaderboard, ApiRequest } from '../../shared/contracts/api.ts';
export class League {
  private $: ReturnType<typeof dom>['get'];
  private api: ApiRequest;
  private tab = 'duels';
  private period = 'week';
  private week: string | null = null;
  private state: AppState | null = null;
  private generation = 0;
  private pending: { key: string; promise: Promise<void> } | null = null;
  private board: Leaderboard | null = null;
  private boardKey: string | null = null;
  private dataKey: string | null = null;
  private boardClock = { now: 0, received: 0 };
  private serverAtReceipt = { now: 0, received: 0 };
  private timer: ReturnType<typeof setInterval>;
  private root: HTMLElement;
  constructor(root: HTMLElement, ctx: FeatureContext) {
    this.root = root;
    this.$ = dom(root).get;
    this.api = ctx.session.api;
    for (const b of root.querySelectorAll<HTMLElement>('[data-competition-tab]')) {
      b.onclick = () => this.open(b.dataset.competitionTab || 'duels');
      b.onkeydown = (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const names = ['duels', 'result', 'points'];
        let i = names.indexOf(this.tab);
        i = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
        this.open(names[i]);
        this.$('competition-tab-' + names[i]).focus();
      };
    }
    this.$('league-week').onchange = () => {
      this.week = this.$('league-week').value;
      void this.load();
    };
    this.$('points-week').onclick = () => {
      this.period = 'week';
      void this.load();
    };
    this.$('points-all').onclick = () => {
      this.period = 'all';
      void this.load();
    };
    this.$('refresh-league').onclick = () => void this.load();
    this.$('league-personal').onclick = () => ctx.chooseMode('personal');
    this.$('league-profile').onclick = () => ctx.openProfile();
    this.timer = setInterval(() => this.renderDeadline(), 1000);
  }
  activate() {
    if (this.tab !== 'duels') void this.load({ quiet: true });
  }
  openWeek(type: 'result' | 'points', week: string) {
    this.week = week;
    this.period = 'week';
    this.open(type);
  }
  render(state: AppState | null) {
    if (state?.profile?.id !== this.state?.profile?.id) {
      this.generation++;
      this.pending = null;
      this.board = null;
      this.boardKey = null;
      this.dataKey = null;
      this.$('league-table').innerHTML = '';
    }
    this.state = state;
    const w = state?.weekly;
    if (!w) return;
    this.serverAtReceipt = { now: state.serverNow, received: performance.now() };
    const options = w.periods
      .map(
        (p) =>
          `<option value="${p.week}">${periodLabel(p.week)}${p.closed ? ' · итоги' : ' · текущая'}</option>`,
      )
      .join('');
    if (this.$('league-week').innerHTML !== options) this.$('league-week').innerHTML = options;
    if (!w.periods.some((p) => p.week === this.week)) this.week = w.sportsWeek;
    this.$('league-week').value = this.week || w.sportsWeek;
    const key = JSON.stringify([
        state.profile,
        state.points,
        state.rounds,
        w.periods,
        w.summaries.map((s) => [s.week, s.revision]),
      ]),
      changed = this.dataKey !== null && this.dataKey !== key;
    this.dataKey = key;
    if (changed && this.tab !== 'duels' && !this.root.hidden) void this.load({ quiet: true });
  }
  open(tab: string) {
    if (!['duels', 'result', 'points'].includes(tab)) return;
    this.tab = tab;
    if (tab === 'duels') {
      this.generation++;
      this.pending = null;
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-competition-tab]')) {
      const active = b.dataset.competitionTab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    }
    this.$('competition-duels').hidden = tab !== 'duels';
    this.$('league-panel').hidden = tab === 'duels';
    this.$('league-panel').setAttribute('aria-labelledby', `competition-tab-${tab}`);
    if (tab !== 'duels') this.load();
  }
  renderDeadline() {
    if (!this.board || this.tab === 'duels' || this.root.hidden) return;
    if (this.tab === 'points' && this.period === 'all') {
      this.$('league-deadline').textContent = 'Все сохранённые дневные награды и недельные бонусы.';
      return;
    }
    if (this.board.periodInfo.closed) {
      this.$('league-deadline').textContent =
        'Спортивная неделя закрыта. Итоговые места сохранены.';
      return;
    }
    const clock = this.boardClock || this.serverAtReceipt,
      now = clock.now + performance.now() - clock.received;
    const seconds = Math.max(0, Math.ceil((this.board.periodInfo.endsAt - now) / 1000));
    const days = Math.floor(seconds / 86400),
      hours = Math.floor((seconds % 86400) / 3600),
      minutes = Math.floor((seconds % 3600) / 60);
    this.$('league-deadline').textContent = seconds
      ? `До конца недели: ${days} д ${hours} ч ${minutes} мин · UTC+2`
      : 'Неделя закончилась. Сервер подтверждает последние раунды и итог.';
  }
  async load({ quiet = false } = {}) {
    if (this.tab === 'duels' || !this.state?.weekly || !this.state.profile) return;
    const type = this.tab,
      period = type === 'result' ? 'week' : this.period;
    const key = `${type}|${period}|${this.week}`,
      requestKey = key + '|' + this.dataKey;
    if (this.pending?.key === requestKey) return this.pending.promise;
    const generation = ++this.generation,
      keep = !!this.board && this.boardKey === key;
    this.$('league-title').textContent =
      type === 'result' ? 'Лучшая минута недели' : 'Баллы за движение';
    this.$('points-periods').hidden = type !== 'points';
    this.$('league-week-label').hidden = period === 'all';
    for (const name of ['week', 'all']) {
      this.$(`points-${name}`).classList.toggle('active', period === name);
      this.$(`points-${name}`).setAttribute('aria-pressed', String(period === name));
    }
    if (!keep) {
      this.$('league-status').textContent = 'Загружаем подтверждённые данные…';
      this.$('league-table').innerHTML = '';
      this.board = null;
    } else if (!quiet) this.$('league-status').textContent = 'Обновляем данные…';
    this.$('refresh-league').disabled = true;
    this.$('league-table').setAttribute('aria-busy', 'true');
    this.$('league-profile').hidden = this.state.profile.rankingsEnabled;
    this.$('league-consent').textContent = this.state.profile.rankingsEnabled
      ? 'Вы участвуете. Имя и показатели видны другим пользователям с доступом к APP.'
      : 'Участие выключено. Ваши данные скрыты из общих таблиц; личные баллы сохраняются.';
    if (!keep) {
      this.$('league-personal').hidden = true;
      this.$('league-sync-note').textContent = '';
      this.$('league-deadline').textContent = '';
    }
    const promise = (async () => {
      try {
        const b = await this.api(`leaderboards?type=${type}&period=${period}&week=${this.week}`);
        if (generation !== this.generation) return;
        this.board = b;
        this.boardKey = key;
        this.boardClock = { now: b.serverNow, received: performance.now() };
        this.$('league-period').textContent =
          period === 'all'
            ? 'Всё время'
            : `${periodLabel(b.week)} · ${type === 'result' ? b.periodInfo.rulesVersion : 'дневные награды и бонусы'}`;
        this.$('league-status').textContent =
          type === 'result'
            ? b.periodInfo.closed
              ? 'Итоговые места'
              : 'Предварительные места'
            : 'Места по баллам · без награды за место';
        this.$('league-table').innerHTML = leaderboardHTML(b, type);
        this.$('league-personal').hidden = type !== 'result' || !!b.you || b.periodInfo.closed;
        this.$('league-sync-note').textContent =
          type === 'points' && b.pointsMayUpdate
            ? `${period === 'all' ? 'Баллы могут обновиться' : 'Баллы этой недели могут обновиться'} после синхронизации ранее выполненных заданий. Спортивные места после закрытия не меняются.`
            : type === 'result'
              ? 'Один лучший завершённый раунд на участника. При равенстве — одинаковое место.'
              : '';
        this.renderDeadline();
      } catch (error) {
        if (generation !== this.generation) return;
        this.$('league-status').textContent = keep
          ? 'Не удалось обновить рейтинг. Показаны предыдущие данные. Нажмите «Обновить».'
          : 'Не удалось загрузить рейтинг. Проверьте сеть и нажмите «Обновить».';
        if (!keep)
          this.$('league-table').innerHTML =
            '<p class="empty-state">Данные не подтверждены. Сохранённый личный прогресс остаётся в вашем профиле.</p>';
      } finally {
        if (generation === this.generation) {
          this.pending = null;
          this.$('refresh-league').disabled = false;
          this.$('league-table').setAttribute('aria-busy', 'false');
        }
      }
    })();
    this.pending = { key: requestKey, promise };
    return promise;
  }
  destroy() {
    this.generation++;
    clearInterval(this.timer);
  }
}
