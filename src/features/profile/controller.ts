import { dom } from '../../shared/dom.ts';
import { errorMessage } from '../../shared/errors.ts';
import { signInGuest, signOutDevice, getTestUser } from '../../api.js';
import { activity } from '../../activity-log.js';
import { isNativeApp } from '../../platform.js';
import { VERSION } from '../../config.js';
import { Lifecycle } from '../../shared/lifecycle.ts';
import type { SessionService } from '../../services/session.ts';
export function createProfile(
  panel: HTMLElement,
  auth: HTMLElement,
  toggle: HTMLButtonElement,
  session: SessionService,
  actions: {
    load: () => Promise<void>;
    showError: (message: string) => void;
    canLogout: () => boolean;
    prepareLogout: () => Promise<boolean>;
  },
) {
  const { get: $, text } = dom(panel),
    login = dom(auth),
    life = new Lifecycle();
  function open(pushState = true) {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    $('rankings-excluded').checked = !session.state?.profile?.rankingsEnabled;
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (pushState) {
      try {
        history.pushState({ panel: 'profile' }, '');
      } catch {}
    }
  }
  function close(popHistory = false) {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (popHistory && history.state?.panel === 'profile') history.back();
  }
  toggle.onclick = () => (panel.hidden ? open() : close(true));
  life.listen(window, 'popstate', () => {
    if (!panel.hidden) close();
  });
  $('profile-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter as HTMLButtonElement | null;
    if (!button) return;
    button.disabled = true;
    try {
      const state = session.requireState();
      const response = await session.api('profile', {
        method: 'POST',
        body: {
          displayName: $('display-name').value,
          timeZone: state.profile.timeZone,
          rankingsEnabled: !$('rankings-excluded').checked,
        },
      });
      await session.apply(response.state);
      close();
    } catch (error) {
      actions.showError(errorMessage(error));
    } finally {
      button.disabled = false;
    }
  };
  async function signIn(name: string) {
    if (session.authBusy || session.loading) return;
    session.authBusy = true;
    render();
    try {
      if (session.state?.profile) {
        if (!actions.canLogout()) {
          actions.showError('Дождитесь завершения текущего действия перед входом.');
          return;
        }
        if (!(await actions.prepareLogout())) return;
      }
      session.reset();
      await signInGuest(name);
      activity.record('auth.login');
      auth.hidden = true;
      await actions.load();
    } catch (error) {
      actions.showError(errorMessage(error));
    } finally {
      session.authBusy = false;
      render();
    }
  }
  login.get('quick-guest-btn').onclick = () =>
    void signIn(`Атлет-${Math.floor(100 + Math.random() * 900)}`);
  login.get('test-login-form').onsubmit = (event) => {
    event.preventDefault();
    const name = login.get('test-username-input').value.trim();
    if (!name) {
      actions.showError('Введите имя для входа.');
      return;
    }
    if (name.length > 40) {
      actions.showError('Имя не должно превышать 40 символов.');
      return;
    }
    void signIn(name);
  };
  $('sign-out-btn').onclick = async () => {
    if (session.authBusy || session.loading || !actions.canLogout()) {
      actions.showError('Дождитесь завершения текущего действия перед выходом.');
      return;
    }
    session.authBusy = true;
    render();
    try {
      if (!(await actions.prepareLogout())) return;
      await signOutDevice();
      activity.record('auth.logout');
      session.reset();
      close();
      location.reload();
    } catch (error) {
      actions.showError(errorMessage(error));
    } finally {
      session.authBusy = false;
      render();
    }
  };
  function render() {
    const state = session.state;
    login.get('quick-guest-btn').disabled = session.authBusy || session.loading;
    login.get('test-login-btn').disabled = session.authBusy || session.loading;
    $('sign-out-btn').disabled = session.authBusy;
    auth.hidden = !!state?.profile && !session.loadError;
    if (!state?.profile) {
      toggle.textContent = 'Мой профиль';
      const input = login.get('test-username-input');
      if (!input.value) input.value = getTestUser();
      return;
    }
    toggle.textContent = state.profile.displayName || 'Мой профиль';
    if (document.activeElement !== $('display-name'))
      $('display-name').value = state.profile.displayName;
    text('profile-timezone', `Часовой пояс: ${state.profile.timeZone}. Сохранён в профиле.`);
    if (panel.hidden) $('rankings-excluded').checked = !state.profile.rankingsEnabled;
  }
  const apkBox = panel.querySelector<HTMLElement>('.apk-download-box');
  if (apkBox) apkBox.hidden = true;
  if (!isNativeApp())
    void fetch('/app-debug.apk.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info: unknown) => {
        if (
          apkBox &&
          typeof info === 'object' &&
          info !== null &&
          'version' in info &&
          info.version === VERSION
        )
          apkBox.hidden = false;
      })
      .catch(() => {});
  return {
    open,
    close,
    render,
    destroy: () => {
      life.destroy();
      toggle.onclick = null;
      panel.remove();
      auth.remove();
    },
  };
}
