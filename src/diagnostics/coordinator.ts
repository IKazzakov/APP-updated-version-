import { Diagnostics } from '../diagnostics.js';
import { DiagnosticsPanel } from '../diagnostics-panel.js';
import { getConnectionDiagnostic } from '../api.js';
import { errorMessage, errorInfo } from '../shared/errors.ts';
import { isNativeApp, getApiBaseUrl } from '../platform.js';
import type { SessionService } from '../services/session.ts';
export function createDiagnostics(
  connection: HTMLElement,
  session: SessionService,
  actions: {
    load: () => Promise<void>;
    retry: () => Promise<void>;
    changeServer: (url: string) => void;
    openProfile: () => void;
  },
) {
  const diagnostics = new Diagnostics();
  const panel = new DiagnosticsPanel({
    diagnostics,
    native: isNativeApp(),
    serverUrl: getApiBaseUrl(),
    onCheckServer: actions.load,
    onRetry: actions.retry,
    onServerChange: actions.changeServer,
    onSignIn: actions.openProfile,
  });
  return {
    diagnostics,
    render() {
      const { sync, loading, loadError, persistenceError, state } = session;
      const needsSignIn = !state?.profile && errorInfo(loadError).status === 401;
      connection.classList.toggle(
        'warning',
        !navigator.onLine || !!sync.error || persistenceError || (!!loadError && !needsSignIn),
      );
      panel.connection({ loading, report: getConnectionDiagnostic(), needsSignIn });
      panel.sync({
        error: !!sync.error || (!!loadError && !needsSignIn),
        loading,
        hasQueue: !!session.outbox,
      });
      if (loading) {
        connection.textContent = 'Подключаемся к серверу…';
        return;
      }
      if (!state?.profile) {
        connection.textContent = needsSignIn
          ? 'Сервер доступен. Нажмите «Быстрый старт (Гость)», чтобы создать профиль.'
          : 'Профиль не загружен. Камеру и подсчёт можно проверить в обычной тренировке.';
        return;
      }
      if (loadError) {
        connection.textContent = errorMessage(loadError);
        return;
      }
      if (persistenceError) {
        connection.textContent =
          'Не удалось записать повторение на устройстве. Сделайте паузу и освободите память.';
        return;
      }
      if (!navigator.onLine) {
        connection.textContent = `Нет сети. ${sync.pending ? `Ожидают сохранения: ${sync.pending}. ` : ''}Подключитесь, чтобы подтвердить прогресс.`;
        return;
      }
      if (sync.error) {
        connection.textContent = `${sync.error} Ожидают сохранения: ${sync.pending ?? '—'}. ${sync.blocked ? 'Нажмите «Повторить сохранение» после устранения причины.' : 'Повторим отправку автоматически.'}`;
        return;
      }
      if (sync.saving || sync.pending) {
        connection.textContent = `Сохраняем повторения… ${sync.pending ? `Ожидают: ${sync.pending}` : ''}`;
        return;
      }
      connection.textContent = 'Прогресс подтверждён сервером · видео остаётся на телефоне';
    },
    destroy: () => panel.destroy(),
  };
}
