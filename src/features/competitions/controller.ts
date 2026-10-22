import { competitionHTML } from './view.ts';
import { dom, dateLabel as formatDate } from '../../shared/dom.ts';
import { errorMessage } from '../../shared/errors.ts';
import { activity } from '../../activity-log.js';
import { copyReport } from '../../clipboard.js';
import { profileStorageId, invitationOrigin } from '../../platform.js';
import type { FeatureContext } from '../../shared/feature.ts';
import { League } from './league.ts';
interface StoredInvite {
  id: string;
  token: string;
  canCancel: boolean;
}
function isInvite(v: unknown): v is StoredInvite {
  return (
    typeof v === 'object' &&
    v !== null &&
    'id' in v &&
    typeof v.id === 'string' &&
    'token' in v &&
    typeof v.token === 'string' &&
    'canCancel' in v &&
    typeof v.canCancel === 'boolean'
  );
}
export function createCompetitions(root: HTMLElement, ctx: FeatureContext) {
  const { get: $, text } = dom(root),
    { session } = ctx,
    api = session.api;
  const applyState = (s: Parameters<typeof session.apply>[0]) => session.apply(s),
    refreshQuietly = ctx.refresh,
    showError = ctx.showError,
    setTab = ctx.navigate,
    chooseMode = ctx.chooseMode;
  const diagnostics = { error: (code: string) => activity.record('app.error', { code }) };
  const dateLabel = (value: number, options?: Intl.DateTimeFormatOptions) =>
    formatDate(value, session.state?.profile?.timeZone || 'UTC', options);
  let busy = false,
    activeInvitation: StoredInvite | null = null,
    receivedInvite = sessionStorage.getItem('movement.receivedInvite');
  const league = new League(root, ctx);
  function renderCompetitions() {
    const state = session.state;
    if (!state?.profile) return;
    const rows = state.competitions;
    $('competition-list').innerHTML = rows.length
      ? rows.map((c) => competitionHTML(c, !!readInvite(c.id), dateLabel)).join('')
      : '<div class="empty-state">Пока нет соревнований.<br>Создайте приглашение или откройте ссылку от друга.</div>';
    const created = activeInvitation && rows.find((c) => c.id === activeInvitation?.id);
    $('cancel-created-challenge').hidden = !(created?.canCancel ?? activeInvitation?.canCancel);
    if (created?.status === 'cancelled') {
      $('invite-created').hidden = true;
      activeInvitation = null;
    }
  }
  function token() {
    return [...crypto.getRandomValues(new Uint8Array(32))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  }
  function inviteKey(id: string) {
    const state = session.requireState();
    return `movement.invite.${profileStorageId(state.profile.id)}.${id}`;
  }
  function readInvite(id: string): StoredInvite | null {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(inviteKey(id)) || 'null');
      return isInvite(saved) ? saved : null;
    } catch {
      return null;
    }
  }
  function showCreatedInvite(invitation: StoredInvite | null) {
    const state = session.state;
    if (!invitation) return;
    activeInvitation = invitation;
    $('invite-created').hidden = false;
    $('invite-url').value = `${invitationOrigin(location.origin)}/#invite=${invitation.token}`;
    $('cancel-created-challenge').hidden = !(
      state?.competitions.find((c) => c.id === invitation.id)?.canCancel ?? invitation.canCancel
    );
  }
  async function cancelChallenge(id: string) {
    const state = session.state;
    if (busy || !state?.profile) return;
    busy = true;
    showError('');
    root
      .querySelectorAll<HTMLButtonElement>('[data-cancel-challenge],#cancel-created-challenge')
      .forEach((b) => (b.disabled = true));
    try {
      const response = await api(`competitions/${id}/cancel`, { method: 'POST', body: {} });
      localStorage.removeItem(inviteKey(id));
      await applyState(response.state);
      await session.loadHistory('competitions', { refresh: true });
    } catch (error) {
      showError(errorMessage(error));
      await refreshQuietly();
    } finally {
      busy = false;
      root
        .querySelectorAll<HTMLButtonElement>('[data-cancel-challenge],#cancel-created-challenge')
        .forEach((b) => (b.disabled = false));
    }
  }
  async function createChallenge() {
    const state = session.state;
    if (!state?.profile || busy) return;
    busy = true;
    $('create-challenge').disabled = true;
    showError('');
    const key = `movement.create.${profileStorageId(state.profile.id)}`;
    let request: { requestId: string; token: string } | null = null;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) || 'null');
      if (
        typeof saved === 'object' &&
        saved !== null &&
        'requestId' in saved &&
        typeof saved.requestId === 'string' &&
        'token' in saved &&
        typeof saved.token === 'string'
      )
        request = { requestId: saved.requestId, token: saved.token };
    } catch {}
    request ??= { requestId: crypto.randomUUID(), token: token() };
    try {
      localStorage.setItem(key, JSON.stringify(request));
      const response = await api('competitions', { method: 'POST', body: request });
      const invite = {
        id: response.competition.id,
        token: request.token,
        canCancel: response.competition.canCancel,
      };
      localStorage.setItem(inviteKey(invite.id), JSON.stringify(invite));
      localStorage.removeItem(key);
      showCreatedInvite(invite);
      await refreshQuietly();
    } catch (error) {
      showError(errorMessage(error));
      diagnostics.error('INVITATION_FAILED');
    } finally {
      busy = false;
      $('create-challenge').disabled = false;
    }
  }
  async function previewInvitation() {
    if (!receivedInvite) return;
    setTab('competitions');
    $('invite-accept').hidden = false;
    $('accept-challenge').disabled = true;
    try {
      const response = await api('invitations/preview', {
          method: 'POST',
          body: { token: receivedInvite },
        }),
        p = 'preview' in response ? response.preview : response;
      text(
        'invite-preview',
        p.status === 'cancelled'
          ? 'Автор отменил вызов. Это приглашение больше не действует. Попросите друга создать новое.'
          : `${p.creatorName} приглашает вас: три попытки по 60 секунд, 24 часа после принятия. ${p.canAccept ? 'После принятия начнётся общий срок.' : 'Приглашение уже занято или недоступно для вашего профиля.'}`,
      );
      $('accept-challenge').disabled = !p.canAccept;
    } catch (error) {
      text('invite-preview', errorMessage(error));
    }
  }
  $('accept-challenge').onclick = async () => {
    const token = receivedInvite;
    if (!token) return;
    $('accept-challenge').disabled = true;
    try {
      const r = await api('invitations/accept', {
        method: 'POST',
        body: { token },
      });
      await applyState(r.state);
      await session.loadHistory('competitions', { refresh: true });
      sessionStorage.removeItem('movement.receivedInvite');
      receivedInvite = null;
      $('invite-accept').hidden = true;
      showError('');
    } catch (error) {
      showError(errorMessage(error));
      $('accept-challenge').disabled = false;
    }
  };
  $('create-challenge').onclick = createChallenge;
  $('refresh-challenges').onclick = () => {
    void refreshQuietly();
    void session.loadHistory('competitions', { refresh: true });
  };
  $('cancel-created-challenge').onclick = () => {
    if (activeInvitation) void cancelChallenge(activeInvitation.id);
  };
  $('copy-invite').onclick = async () => {
    const success = await copyReport($('invite-url'));
    text(
      'invite-copy-status',
      success ? 'Ссылка скопирована. Отправьте её другу.' : 'Выделите ссылку и скопируйте вручную.',
    );
  };
  $('competitions-more').onclick = () => void session.loadHistory('competitions', { more: true });
  const click = (e: Event) => {
    const b = (e.target as Element).closest<HTMLElement>(
      '[data-attempt],[data-invite],[data-cancel-challenge]',
    );
    if (!b) return;
    if (b.dataset.attempt) chooseMode('competition', b.dataset.attempt);
    else if (b.dataset.invite) showCreatedInvite(readInvite(b.dataset.invite));
    else if (b.dataset.cancelChallenge) void cancelChallenge(b.dataset.cancelChallenge);
  };
  root.addEventListener('click', click);
  return {
    root,
    get busy() {
      return busy;
    },
    render: () => {
      renderCompetitions();
      league.render(session.state);
      const p = session.pageInfo('competitions');
      $('competitions-more').hidden = !session.client.compact || !p.next;
      $('competitions-more').disabled = !!p.loading;
    },
    refresh: () => {
      void session.loadHistory('competitions', { refresh: true });
    },
    activate: () => {
      league.activate();
      void session.loadHistory('competitions', { refresh: true });
    },
    preview: async () => {
      receivedInvite = sessionStorage.getItem('movement.receivedInvite');
      if (receivedInvite) await previewInvitation();
    },
    openLeague: (type: 'result' | 'points', week: string) => league.openWeek(type, week),
    destroy: () => {
      league.destroy();
      root.removeEventListener('click', click);
    },
  };
}
