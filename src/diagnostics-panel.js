import './diagnostics.css';
import { activity } from './activity-log.js';
import { copyReport, selectReport } from './clipboard.js';

const labels = {
  'app.ready': 'Приложение открыто',
  'ui.action': 'Действие',
  'ui.tab': 'Раздел',
  'app.visibility': 'Видимость приложения',
  'app.online': 'Сеть восстановлена',
  'app.offline': 'Нет сети',
  'app.error': 'Ошибка приложения',
  'request.start': 'Запрос отправлен',
  'request.end': 'Ответ сервера',
  'request.error': 'Ошибка запроса',
  'queue.saved': 'Повторение сохранено на устройстве',
  'queue.sending': 'Отправка повторений',
  'queue.confirmed': 'Сохранение подтверждено',
  'queue.error': 'Ошибка сохранения',
  'training.changed': 'Состояние тренировки',
  'round.start': 'Запуск раунда',
  'round.end': 'Раунд завершён',
  'auth.login': 'Вход',
  'auth.logout': 'Выход',
  'server.check': 'Проверка сервера',
  'server.changed': 'Адрес сервера изменён',
  'report.copied': 'Отчёт подготовлен',
  'journal.cleared': 'Журнал очищен',
  'model.loading': 'Загрузка модели',
  'model.ready': 'Модель готова',
  'model.error': 'Ошибка модели',
};
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export class DiagnosticsPanel {
  constructor({ diagnostics, onCheckServer, onRetry, onServerChange, serverUrl, native = false }) {
    this.diagnostics = diagnostics;
    this.root = document.createElement('details');
    this.root.id = 'diagnostics';
    this.root.className = 'diagnostics diagnostics-dock';
    this.root.innerHTML = `<summary><strong>Диагностика</strong><span id="activity-summary">Журнал активности</span></summary><div class="diagnostics-content"><section class="diagnostics-connection" aria-label="Проверка подключения"><h2>Подключение к серверу</h2><button id="check-server" class="button secondary" type="button">Проверить соединение</button><button id="retry-sync" class="button secondary" type="button" hidden>Повторить сохранение</button><p id="server-result" role="status">NOT_CHECKED</p><details id="server-settings" ${native ? '' : 'hidden'}><summary>Изменить адрес сервера</summary><form id="server-form"><label for="server-url">Адрес опубликованного сервера</label><input id="server-url" type="url" required inputmode="url" autocomplete="off"><button class="button secondary" type="submit">Сохранить и подключиться</button></form></details></section><dl id="diag-values"></dl><div class="diagnostics-toolbar"><button id="copy" class="button secondary">Скопировать диагностику</button><button id="clear-activity" class="button secondary">Очистить журнал</button></div><p id="copy-status" role="status"></p><p class="muted">Журнал текущего сеанса: последние 300 событий. Без видео, точек тела, имён, токенов и ссылок-приглашений.</p><ol id="activity-list" class="activity-list" aria-label="Журнал активности приложения"></ol><label for="copy-fallback" class="muted">Отчёт для ручного копирования</label><textarea id="copy-fallback" readonly spellcheck="false" aria-label="Диагностический отчёт"></textarea><button id="select-report" class="button secondary">Выделить отчёт</button></div>`;
    document.body.append(this.root);
    this.$ = (id) => this.root.querySelector('#' + id);
    this.$('server-url').value = serverUrl || '';
    this.$('check-server').onclick = () => {
      activity.record('server.check');
      onCheckServer();
    };
    this.$('retry-sync').onclick = onRetry;
    this.$('server-form').onsubmit = (event) => {
      event.preventDefault();
      try {
        onServerChange(this.$('server-url').value);
        activity.record('server.changed');
      } catch {
        this.$('server-result').textContent =
          'Не удалось сменить сервер. Выключите камеру, дождитесь сохранения и проверьте HTTPS-адрес.';
      }
    };
    this.$('copy').onclick = async () => {
      activity.record('report.copied');
      this.$('copy-fallback').value = diagnostics.reportText();
      const ok = await copyReport(this.$('copy-fallback'));
      this.$('copy-status').textContent = ok
        ? 'Диагностика скопирована. Вставьте её в чат.'
        : 'Отчёт подготовлен ниже. Выделите его и скопируйте вручную.';
    };
    this.$('select-report').onclick = () => selectReport(this.$('copy-fallback'));
    this.$('clear-activity').onclick = () => {
      activity.clear();
      this.$('copy-fallback').value = '';
    };
    this.root.addEventListener('toggle', () => {
      activity.record('ui.action', { action: 'diagnostics' });
      if (this.root.open) this.render();
    });
    this.unsubscribe = activity.subscribe(() => {
      if (!this.queued) {
        this.queued = true;
        requestAnimationFrame(() => {
          this.queued = false;
          this.render();
        });
      }
    });
    this.timer = setInterval(() => this.renderMetrics(), 1000);
    this.onClick = (event) => {
      const b = event.target.closest('button,[data-tab]');
      if (!b) return;
      const action =
        b.dataset.tab ||
        b.dataset.competitionTab ||
        (b.dataset.attempt
          ? 'attempt'
          : b.dataset.invite
            ? 'invite'
            : b.dataset.cancelChallenge
              ? 'cancel'
              : b.dataset.seenWeek
                ? 'seen-week'
                : b.id);
      activity.record(b.dataset.tab ? 'ui.tab' : 'ui.action', { action });
    };
    this.onSubmit = (event) => activity.record('ui.action', { action: event.target.id });
    this.onChange = (event) => activity.record('ui.action', { action: event.target.id });
    this.onError = () => activity.record('app.error', { code: 'UNKNOWN_ERROR' });
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('submit', this.onSubmit, true);
    document.addEventListener('change', this.onChange, true);
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onError);
    activity.record('app.ready');
    this.render();
  }
  connection({ loading, report }) {
    this.$('check-server').disabled = loading;
    this.$('server-result').textContent = loading
      ? 'Проверяем соединение…'
      : `${report.status ? 'HTTP ' + report.status + ' · ' : ''}${report.code}`;
  }
  renderMetrics() {
    const v = this.diagnostics.values;
    this.$('diag-values').innerHTML = Object.entries({
      Модель: v.model,
      Камера: v.camera,
      Разрешение: v.resolution,
      'Кадров/с': v.fps,
      'Обработка, мс': v.inferenceMs,
      Состояние: v.phase,
    })
      .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v ?? '—')}</dd>`)
      .join('');
  }
  render() {
    const entries = activity.snapshot();
    this.$('activity-summary').textContent =
      `${entries.length} событий · ${labels[entries.at(-1)?.event] || 'Журнал активности'}`;
    if (!this.root.open) return;
    this.renderMetrics();
    this.$('activity-list').innerHTML = entries
      .reverse()
      .map(
        ({ sequence, at, event, ...meta }) =>
          `<li class="activity-entry ${event.endsWith('error') ? 'activity-error' : ''}"><time datetime="${escape(at)}">${escape(new Date(at).toLocaleTimeString('ru-RU'))}</time><div><strong>${escape(labels[event] || event)}</strong><small>${escape(
            Object.entries(meta)
              .map(([key, value]) => `${key}: ${value}`)
              .join(' · '),
          )}</small></div></li>`,
      )
      .join('');
  }
  destroy() {
    this.unsubscribe();
    clearInterval(this.timer);
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('submit', this.onSubmit, true);
    document.removeEventListener('change', this.onChange, true);
    window.removeEventListener('error', this.onError);
    window.removeEventListener('unhandledrejection', this.onError);
    this.root.remove();
  }
}
