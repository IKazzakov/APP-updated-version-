import { RoundPersistence } from '../../services/round-persistence.ts';
import { Training, type TrainingState } from '../../training.js';
import { ApiError, getConnectionDiagnostic } from '../../api.js';
import { Diagnostics } from '../../diagnostics.js';
import { activity } from '../../activity-log.js';
import { CameraLease } from '../../camera-lease.js';
import { RoundPreparation } from '../../round-preparation.js';
import { RoundSound } from '../../sound.js';
import { ScreenWakeLock } from '../../wake-lock.js';
import { serverTimeAtReceipt } from '../../round-clock.js';
import { isNativeApp, profileStorageId } from '../../platform.js';
import { dom, escape } from '../../shared/dom.ts';
import { errorMessage, errorInfo } from '../../shared/errors.ts';
import { resultComparison } from '../../shared/progress.ts';
import type {
  TrainingMode,
  Repetition,
  RoundResult,
  StartRoundInput,
} from '../../shared/contracts/api.ts';
import type { FeatureContext } from '../../shared/feature.ts';
import { createTrainingView } from './view.ts';
export function createTraining(
  root: HTMLElement,
  ctx: FeatureContext,
  diagnostics: Diagnostics,
  actions: { getError: () => string },
) {
  const { session } = ctx,
    api = session.api,
    { get: $, text } = dom(root),
    view = createTrainingView(root);
  const showError = ctx.showError,
    setTab = ctx.navigate,
    refreshQuietly = ctx.refresh;
  let mode: TrainingMode = 'practice',
    competitionId: string | null = null,
    busy = false,
    roundSaving = false,
    localPracticeSession = false;
  let lastTraining: TrainingState | null = null,
    visualSignal: { message: string; until: number } | null = null;
  let pendingStart: StartRoundInput | null = null;
  const persistence = new RoundPersistence(session);
  const cameraLease = new CameraLease({ native: isNativeApp() }),
    wakeLock = new ScreenWakeLock();
  const sound = new RoundSound({
    onChange: (message) => {
      text('sound-status', message);
      if (lastTraining) renderTraining(engine.state);
    },
  });
  const preparation = new RoundPreparation({
    onChange: (s) => {
      if (['idle', 'waiting', 'error'].includes(s.status)) sound.stop();
      if (['idle', 'error'].includes(s.status)) wakeLock.release();
      if (lastTraining) renderTraining(engine.state);
    },
    onSignal: announceSignal,
    onStart: launchRound,
  });
  const engine = new Training($('video'), $('overlay'), {
    onChange: (s) => {
      if (!s.cameraOn && !s.starting && preparation.pending) preparation.cancel();
      if (!s.cameraOn && !s.starting) wakeLock.release();
      preparation.observe(s);
      renderTraining(s);
    },
    onRepetition: (event) => {
      void saveRepetition(event);
    },
    onError: (error) => {
      wakeLock.release();
      diagnostics.error(error.name === 'NotAllowedError' ? 'CAMERA_DENIED' : 'CAMERA_OR_MODEL');
      showError(lastTraining?.reason || 'Не удалось запустить камеру. Повторите попытку.');
    },
    onRoundEnd: (result) => {
      wakeLock.release();
      void saveRound(result);
    },
  });
  function chooseMode(next: TrainingMode, id: string | null = null) {
    cancelCountdown();
    engine.stopCamera('Выбран новый режим');
    mode = next;
    competitionId = id;
    pendingStart = null;
    $('round-result').hidden = true;
    $('practice-mode').classList.toggle('active', next === 'practice');
    $('practice-mode').setAttribute('aria-pressed', String(next === 'practice'));
    $('personal-mode').classList.toggle('active', next === 'personal');
    $('personal-mode').setAttribute('aria-pressed', String(next === 'personal'));
    text(
      'mode-title',
      next === 'practice'
        ? 'Приседания без таймера'
        : next === 'personal'
          ? 'Мой результат за 60 секунд'
          : 'Соревновательная попытка · до 60 секунд',
    );
    text(
      'mode-description',
      next === 'practice'
        ? 'Любой удобный темп, подходы и паузы. Повторения сохраняются в дневном задании.'
        : next === 'personal'
          ? 'Подготовиться → положение 2 секунды → 5–4–3–2–1 → ровно 60 секунд. Пауза недоступна. Уход в фон или выключение камеры прерывает попытку.'
          : 'Подготовиться → положение 2 секунды → 5–4–3–2–1 → до 60 секунд. При досрочной остановке повторения идут в счёт вызова. Попытка расходуется при запуске таймера. Для личного рекорда нужна полная минута.',
    );
    text(
      'session-tag',
      next === 'practice' ? 'ЭТОТ ПОДХОД' : next === 'personal' ? 'ЛИЧНЫЙ РАУНД' : 'СОРЕВНОВАНИЕ',
    );
    setTab('training');
    renderTraining(engine.state);
  }
  function renderTraining(s: TrainingState) {
    lastTraining = s;
    updateDiagnostics(s);
    if (!s.cameraOn && !s.starting && !busy) {
      cameraLease.release();
      localPracticeSession = false;
    }
    view.render(s, {
      mode,
      busy,
      roundSaving,
      localPracticeSession,
      hasProfile: !!session.state?.profile,
      outboxReady: session.outboxReady,
      preparation,
      visualSignal,
      sound,
      errorMessage: actions.getError(),
    });
  }
  async function saveRepetition(event: Omit<Repetition, 'id'>) {
    if (localPracticeSession || !session.outboxReady) return;
    try {
      await persistence.record(event);
    } catch {
      engine.mode === 'practice'
        ? engine.pause()
        : engine.abortRound('Не удалось сохранить повторение');
      diagnostics.error('LOCAL_STORAGE');
      session.notify();
    }
  }
  function announceSignal(kind: string) {
    sound.play(kind);
    if (kind === 'start') visualSignal = { message: 'Старт!', until: performance.now() + 900 };
    if (kind === 'end') visualSignal = { message: 'Время вышло', until: Infinity };
  }
  function cancelCountdown() {
    visualSignal = null;
    preparation.cancel();
    sound.stop();
    wakeLock.release();
  }
  function updateDiagnostics(s: TrainingState) {
    diagnostics.update({
      ...s,
      mode,
      preparationStatus: preparation.status,
      soundEnabled: sound.enabled,
      soundAvailable: sound.context?.state === 'running',
      apiConnection: getConnectionDiagnostic(),
    });
  }
  async function start() {
    if (
      busy ||
      roundSaving ||
      preparation.pending ||
      (mode !== 'practice' && (!session.state?.profile || !session.outboxReady))
    )
      return;
    showError('');
    $('round-result').hidden = true;
    visualSignal = null;
    if (mode === 'practice') {
      if (!engine.state.cameraOn)
        localPracticeSession = !session.state?.profile || !session.outboxReady;
      busy = true;
      renderTraining(engine.state);
      try {
        if (await acquireCamera()) {
          wakeLock.acquire();
          await engine.startPractice();
          $('video-layer').scrollIntoView({ block: 'center', behavior: 'instant' });
        }
      } finally {
        busy = false;
        renderTraining(engine.state);
      }
      return;
    }
    // AudioContext is created/resumed inside this user gesture, before awaiting
    // the camera permission. Only this explicit action can arm automatic start.
    const audioReady = sound.enabled ? sound.unlock() : Promise.resolve(false);
    const generation = preparation.arm();
    busy = true;
    if (matchMedia('(max-width: 640px)').matches)
      $('preparation-status').scrollIntoView({ block: 'start', behavior: 'smooth' });
    try {
      if (!(await acquireCamera())) {
        preparation.fail();
        return;
      }
      wakeLock.acquire();
      if (generation !== preparation.generation) return;
      const ready = await engine.prepareRound(mode);
      if (ready) $('video-layer').scrollIntoView({ block: 'center', behavior: 'instant' });
      if (!ready || document.hidden) {
        preparation.cancel();
        wakeLock.release();
        return;
      }
      preparation.wait(generation);
    } finally {
      await audioReady;
      busy = false;
      renderTraining(engine.state);
    }
  }
  async function launchRound({ isCurrent }: { isCurrent: () => boolean }) {
    if (!isCurrent() || document.hidden || mode === 'practice') return false;
    const permit = engine.captureStartPermit();
    if (!permit) {
      showError(
        'Исходное положение изменилось перед запуском. Нажмите «Подготовиться» и повторите.',
      );
      diagnostics.error('START_POSE_LOST');
      return false;
    }
    diagnostics.startEvent('requesting');
    busy = true;
    renderTraining(engine.state);
    pendingStart ??= {
      requestId: crypto.randomUUID(),
      kind: mode,
      ...(competitionId ? { competitionId } : {}),
    };
    const requestStarted = performance.now();
    let round = null;
    try {
      const response = await api('rounds/start', { method: 'POST', body: pendingStart });
      round = response.round;
      pendingStart = null;
      if (round.status !== 'active' || response.serverNow >= round.endsAt)
        throw new ApiError('ROUND_INTERRUPTED', 409);
      sessionStorage.setItem(
        `movement.active.${profileStorageId(session.requireState().profile.id)}`,
        round.id,
      );
      const receivedAt = performance.now(),
        serverAtReceipt = serverTimeAtReceipt(response, receivedAt - requestStarted);
      const serverNow = serverAtReceipt + performance.now() - receivedAt;
      if (!isCurrent() || document.hidden || !engine.beginRound({ ...round, serverNow }, permit)) {
        await api(`rounds/${round.id}/abort`, { method: 'POST', body: {} });
        sessionStorage.removeItem(
          `movement.active.${profileStorageId(session.requireState().profile.id)}`,
        );
        diagnostics.startEvent('cancelled', performance.now() - requestStarted);
        showError(
          'Запуск отменён. Если сервер уже запустил минуту, попытка отмечена как прерванная.',
        );
        return false;
      }
      diagnostics.startEvent('confirmed', performance.now() - requestStarted);
      return true;
    } catch (error) {
      diagnostics.startEvent('rejected', performance.now() - requestStarted);
      showError(errorMessage(error));
      diagnostics.error('ROUND_START_FAILED');
      return false;
    } finally {
      busy = false;
      renderTraining(engine.state);
      refreshQuietly();
    }
  }
  async function acquireCamera() {
    if (await cameraLease.acquire()) return true;
    showError(
      cameraLease.supported
        ? 'Камера используется другой вкладкой этого приложения. Выключите камеру в ней и повторите запуск.'
        : 'Откройте приложение в актуальном Chrome: нужна поддержка безопасного запуска камеры в одной вкладке.',
    );
    return false;
  }

  async function saveRound(result: RoundResult) {
    activity.record('round.end', { stage: result.status, mode });
    if (!result.id || !session.state?.profile) return;
    if (result.status === 'completed') preparation.complete();
    else preparation.cancel();
    roundSaving = true;
    try {
      persistence.remember(result);
    } catch {
      diagnostics.error('LOCAL_STORAGE');
    }
    renderTraining(engine.state);
    $('round-result').hidden = false;
    text(
      'round-result',
      result.status === 'completed'
        ? 'Время вышло. Подтверждаем результат на сервере…'
        : 'Попытка прервана. Сохраняем уже засчитанные повторения…',
    );
    try {
      await finalize(result);
    } catch (error) {
      if (errorInfo(error).code === 'ROUND_INTERRUPTED') {
        persistence.forget();
        sessionStorage.removeItem(
          `movement.active.${profileStorageId(session.requireState().profile.id)}`,
        );
        $('round-result').innerHTML =
          '<h2>Попытка прервана</h2><p>Сервер не получил завершение вовремя. Рекорд за минуту не создан. Сохранённые повторения остаются в дневном задании; в вызове учитывается подтверждённый счёт попытки.</p>';
        await refreshQuietly();
      } else {
        showError(errorMessage(error));
        $('round-result').innerHTML =
          '<h2>Результат ещё не подтверждён</h2><p>Не закрывайте страницу. Повторите отправку после восстановления сети.</p><button id="retry-round" class="button secondary">Повторить сохранение</button>';
        $('retry-round').onclick = () => saveRound(result);
        diagnostics.error('SAVE_FAILED');
      }
    } finally {
      roundSaving = false;
      renderTraining(engine.state);
    }
  }
  async function finalize(result: RoundResult) {
    const round = await persistence.finish(result);
    const completed = round?.status === 'completed';
    $('round-result').innerHTML = completed
      ? `<h2>Время вышло · ${round.count} приседаний за минуту</h2><p>Результат сохранён. ${escape(resultComparison(session.state))}</p><button id="see-progress" class="button secondary">Посмотреть мой прогресс</button>`
      : round?.kind === 'competition'
        ? `<h2>Вызов · засчитано: ${round.count}</h2><p>Попытка завершена досрочно. ${round.count > 0 ? 'Повторения засчитаны в вызове и дневном задании. В зачёт вызова идёт лучшая попытка.' : 'Повторений нет, счёт вызова не увеличен.'} Попытка израсходована. Для личного рекорда и рейтинга за 60 секунд нужна полная минута.</p>`
        : '<h2>Попытка прервана</h2><p>Она не участвует в рекордах. Подтверждённые повторения учтены в дневном задании.</p>';
    root
      .querySelector<HTMLButtonElement>('#see-progress')
      ?.addEventListener('click', () => setTab('progress'));
  }
  async function retryFinalization() {
    const saved = persistence.pending();
    if (!saved) return;
    // An active round never resumes after reload. A completed local minute may
    // only be confirmed during the server's bounded finish-delivery grace.
    if (session.state?.activeRound?.id === saved.id) saved.status = 'interrupted';
    try {
      await finalize(saved);
    } catch {
      showError('Есть неподтверждённая попытка. Сервер не включит её в рекорд без завершения.');
    }
  }
  $('practice-mode').onclick = () => chooseMode('practice');
  $('personal-mode').onclick = () => chooseMode('personal');
  $('start').onclick = start;
  $('cancel-preparation').onclick = () => {
    cancelCountdown();
    engine.stopCamera('Подготовка отменена');
    cameraLease.release();
    wakeLock.release();
  };
  $('sound-enabled').onchange = () => {
    sound.setEnabled($('sound-enabled').checked);
    if (sound.enabled) void sound.unlock();
    else text('sound-status', 'Звук выключен. Ориентируйтесь на экран.');
  };
  $('test-sound').onclick = async () => {
    if (!sound.enabled) {
      text('sound-status', 'Включите «Звук», чтобы проверить сигнал.');
      return;
    }
    if (await sound.unlock()) {
      sound.stop();
      if (sound.play('start'))
        text('sound-status', 'Проверочный сигнал воспроизведён. Проверьте громкость телефона.');
    }
  };
  $('pause').onclick = () => (engine.state.paused ? engine.resume() : engine.pause());
  $('reset').onclick = () => engine.reset();
  $('stop').onclick = () => {
    cancelCountdown();
    engine.stopCamera();
    cameraLease.release();
    wakeLock.release();
  };
  $('early-stop').onclick = () => {
    engine.abortRound('Завершено досрочно');
    wakeLock.release();
  };
  $('switch-camera').onclick = async () => {
    cancelCountdown();
    busy = true;
    try {
      await engine.switchCamera();
    } finally {
      busy = false;
      renderTraining(engine.state);
    }
  };
  $('show-points').onchange = () => engine.setOverlay($('show-points').checked);
  return {
    root,
    chooseMode,
    render: () => renderTraining(engine.state),
    retryFinalization,
    get busy() {
      return busy || roundSaving || preparation.pending;
    },
    get cameraOn() {
      return engine.state.cameraOn || engine.state.starting;
    },
    get running() {
      return engine.state.roundStatus === 'running';
    },
    deactivate: () => {
      cancelCountdown();
      engine.stopCamera('Вы перешли в другой раздел');
    },
    onHidden: () => {
      cancelCountdown();
      wakeLock.release();
    },
    onPageHide: () => {
      cameraLease.release();
      wakeLock.release();
      const round = engine.clock.id;
      if (round && engine.roundStatus !== 'completed')
        void api(`rounds/${round}/abort`, { method: 'POST', body: {}, keepalive: true }).catch(
          () => {},
        );
    },
    prepareLogout: async () => {
      cancelCountdown();
      engine.stopCamera();
      await persistence.settled();
      if (session.outbox && (await session.outbox.count())) {
        showError('Сначала дождитесь сохранения повторений, затем выйдите из профиля.');
        return false;
      }
      return true;
    },
    recoverReload: async () => {
      if (await persistence.recoverReload())
        showError(
          'Предыдущая незавершённая попытка прервана. Сохранённые повторения остаются в дневном задании; в вызове учитывается подтверждённый счёт попытки.',
        );
    },
    destroy: () => {
      cancelCountdown();
      engine.destroy();
      cameraLease.release();
      wakeLock.destroy();
      sound.stop();
      void sound.context?.close();
    },
  };
}
