import { dom } from '../shared/dom.ts';
import { VERSION } from '../config.js';
import { Lifecycle } from '../shared/lifecycle.ts';
import { errorMessage, errorInfo } from '../shared/errors.ts';
import { activity } from '../activity-log.js';
import { SessionService } from '../services/session.ts';
import { WorkoutsService } from '../services/workouts.ts';
import {
  rememberWorkoutProfile,
  restoreWorkoutProfile,
  forgetWorkoutProfile,
} from '../features/workouts/offline.ts';
import { Navigation } from './navigation.ts';
import { mountScreens, type FeatureScreen } from './registry.ts';
import { createProfile } from '../features/profile/controller.ts';
import { createDiagnostics } from '../diagnostics/coordinator.ts';
import { isNativeApp, setNativeApiUrl, migrateLegacyApi } from '../platform.js';
import type { FeatureContext } from '../shared/feature.ts';
import profilePanel from '../features/profile/panel.html?raw';
import authPanel from '../features/profile/auth.html?raw';

export function bootstrap(app: HTMLElement) {
  const versionLabel = app.querySelector<HTMLElement>('[data-app-version]');
  if (versionLabel) versionLabel.textContent = `ДВИЖЕНИЕ / ${VERSION}`;
  migrateLegacyApi();
  app.querySelector<HTMLElement>('[data-profile="panel"]')!.innerHTML = profilePanel;
  app.querySelector<HTMLElement>('[data-profile="auth"]')!.innerHTML = authPanel;
  const { get: $, text } = dom(app),
    life = new Lifecycle();
  const showError = (message: string) => {
    $('app-error').hidden = !message;
    text('app-error', message);
  };
  const session = new SessionService((error) => showError(errorMessage(error)));
  const workouts = new WorkoutsService(session);
  const navigation = new Navigation(app.querySelector<HTMLElement>('nav')!, () => {
    if (navigation.current !== 'training') void refresh(false);
  });
  const diagnostics = createDiagnostics($('connection'), session, {
    load,
    openProfile: () => profile.open(),
    retry: async () => {
      if (session.loadError || !session.outbox) await load();
      else await session.retry();
      try {
        await workouts.retry();
      } catch (error) {
        showError(errorMessage(error));
      }
    },
    changeServer: (url) => {
      if (
        training.cameraOn ||
        training.busy ||
        competitions.busy ||
        workouts.unfinished ||
        workouts.pending
      )
        throw new Error('BUSY');
      setNativeApiUrl(url);
      session.destroy();
      location.reload();
    },
  });
  const ctx: FeatureContext = {
    session,
    workouts,
    openWorkout: (id) => {
      navigation.open('training');
      training.openWorkout(id);
    },
    navigate: (screen) => navigation.open(screen),
    chooseMode: (mode, id) => training.chooseMode(mode, id),
    openProfile: () => profile.open(),
    openLeague: (type, week) => {
      navigation.open('competitions');
      competitions.openLeague(type, week);
    },
    showError,
    refresh,
  };
  const features = mountScreens($('screens'), app.querySelector<HTMLElement>('nav')!, ctx, {
    diagnostics: diagnostics.diagnostics,
    getError: () => $('app-error').textContent || '',
  });
  const { training, competitions } = features;
  const allFeatures: Record<string, FeatureScreen> = features;
  const profile = createProfile($('profile-panel'), $('auth-panel'), $('profile-toggle'), session, {
    load,
    showError,
    canLogout: () => !training.busy && !training.running && !competitions.busy,
    prepareLogout: async () => {
      if (!(await training.prepareLogout())) return false;
      forgetWorkoutProfile();
      return true;
    },
  });
  for (const [id, feature] of Object.entries(features)) navigation.register(id, feature);
  for (const button of app.querySelectorAll<HTMLElement>('[data-tab]'))
    life.listen(button, 'click', () => navigation.open(button.dataset.tab || 'today'));
  function render() {
    workouts.observeSession();
    if (workouts.authorizationRequired) forgetWorkoutProfile();
    profile.render();
    for (const feature of Object.values(allFeatures)) feature.render();
    diagnostics.render();
  }
  life.add(session.store.subscribe(render));
  function activateData() {
    allFeatures[navigation.current]?.refresh?.();
  }
  async function load() {
    if (session.loading) return;
    session.loading = true;
    session.loadError = null;
    showError('');
    session.notify();
    const epoch = session.store.epoch;
    try {
      await session.apply(await session.api('state'), epoch);
      if (epoch !== session.store.epoch) return;
      await training.recoverReload();
      await training.retryFinalization();
      const sent = await session.outbox?.flush();
      if (sent) await session.apply(sent, epoch);
      if (epoch !== session.store.epoch) return;
      void rememberWorkoutProfile(session.state);
      try {
        await workouts.connect();
        await workouts.refresh();
        void workouts.refreshCatalog();
        if (!workouts.apiUnavailable && (workouts.pending || workouts.record?.pendingEnd))
          await workouts.sync();
      } catch {
        /* the legacy app remains usable if the program journal cannot open */
      }
      await activateData();
      await competitions.preview();
    } catch (error) {
      if (epoch !== session.store.epoch) return;
      if (
        navigator.onLine === false &&
        !session.state?.profile &&
        ['NETWORK', 'TIMEOUT'].includes(errorInfo(error).code)
      ) {
        const cached = await restoreWorkoutProfile();
        if (cached && epoch === session.store.epoch && navigator.onLine === false) {
          await session.apply(cached, epoch);
          if (epoch !== session.store.epoch) return;
          await workouts.connect();
          session.loadError = null;
          showError(
            'Нет связи. Доступен сохранённый профиль и локальные программы. Новая активность ожидает подтверждения сервера.',
          );
          return;
        }
      }
      if (errorInfo(error).status === 401) forgetWorkoutProfile();
      session.loadError = error;
      if (errorInfo(error).status !== 401) showError(errorMessage(error));
      diagnostics.diagnostics.error(
        errorInfo(error).status === 401 ? 'AUTH_REQUIRED' : errorInfo(error).code,
      );
    } finally {
      session.loading = false;
      session.notify();
    }
  }
  async function refresh(reloadPages = true) {
    if (!session.state?.profile) {
      if (!session.authBusy) await load();
      return;
    }
    await session.refresh();
    await workouts.refresh();
    if (!workouts.apiUnavailable && (workouts.pending || workouts.record?.pendingEnd))
      void workouts.sync().catch(() => {});
    if (reloadPages) activateData();
  }
  function invitation() {
    const match = location.hash.match(/^#invite=([a-f0-9]{64})$/);
    if (!match) return;
    sessionStorage.setItem('movement.receivedInvite', match[1]);
    history.replaceState(null, '', location.pathname + location.search);
    if (session.state?.profile) void competitions.preview();
  }
  invitation();
  life.listen(window, 'hashchange', invitation);
  life.listen(window, 'online', () => {
    activity.record('app.online');
    session.notify();
    void refresh();
  });
  life.listen(window, 'offline', () => {
    activity.record('app.offline');
    session.notify();
  });
  life.listen(window, 'storage', (event) => {
    if ((event as StorageEvent).key?.startsWith('movement.')) void refresh();
  });
  life.listen(document, 'visibilitychange', () => {
    activity.record('app.visibility', { hidden: document.hidden });
    if (document.hidden) training.onHidden();
    else void refresh();
  });
  life.listen(window, 'pagehide', () => training.onPageHide());
  life.interval(() => {
    if (!document.hidden && navigation.current !== 'training') void refresh();
  }, 30000);
  if (
    !isNativeApp() &&
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))
  ) {
    life.listen(window, 'load', () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
  render();
  void load();
  return {
    destroy() {
      life.destroy();
      navigation.destroy();
      profile.destroy();
      diagnostics.destroy();
      session.destroy();
      workouts.destroy();
      $('screens').replaceChildren();
      app.querySelector('nav')?.replaceChildren();
    },
  };
}
