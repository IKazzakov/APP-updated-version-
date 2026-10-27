import { Camera, cameraError } from '../../camera.js';
import { ApiError } from '../../api.js';
import { errorMessage } from '../../shared/errors.ts';
import { rememberWorkoutProfile } from './offline.ts';
import { quantizeHoldInterval } from './hold-interval.ts';
import { Vision } from '../../models.js';
import { CameraLease } from '../../camera-lease.js';
import { ScreenWakeLock } from '../../wake-lock.js';
import { isNativeApp } from '../../platform.js';
import { drawOverlay } from '../../overlay.js';
import { SquatCounter, squatFeatures } from '../../algorithms/squat.js';
import { PushupCounter, pushupFeatures } from '../../algorithms/pushup.ts';
import { PlankCounter, plankFeatures } from '../../algorithms/plank.ts';
import { expandWorkoutSteps, findWorkoutProgram } from '../../shared/workouts/catalog.ts';
import type { FeatureContext } from '../../shared/feature.ts';
import type { WorkoutProgram, WorkoutStep } from '../../shared/contracts/workouts.ts';
import type { PosePoint } from '../../algorithms/bodyweight.ts';
import './style.css';

export const EXERCISE_NAMES = { squat: 'Приседания', pushup: 'Отжимания', plank: 'Планка' };
export const stepLabel = (step: WorkoutStep) =>
  `${EXERCISE_NAMES[step.exercise]} · ${step.unit === 'ms' ? step.target / 1000 + ' с' : step.target + ' повторений'}`;
type PoseResult = { landmarks: PosePoint[][]; timestamp: number; epoch: number; ms: number };
type Stage =
  | 'idle'
  | 'starting'
  | 'preparing'
  | 'countdown'
  | 'running'
  | 'rest'
  | 'paused'
  | 'saving'
  | 'ended';

/** A program owns its camera only while this screen is explicitly running. */
export function createWorkoutRunner(
  root: HTMLElement,
  ctx: FeatureContext,
  beforeStart: () => Promise<void>,
) {
  const service = ctx.workouts;
  const query = <T extends HTMLElement = HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-workout-${name}]`)!;
  const video = query<HTMLVideoElement>('video'),
    canvas = query<HTMLCanvasElement>('overlay');
  const lease = new CameraLease({ native: isNativeApp() }),
    wake = new ScreenWakeLock();
  const squat = new SquatCounter(),
    pushup = new PushupCounter(),
    plank = new PlankCounter();
  let selected: WorkoutProgram | undefined,
    stage: Stage = 'idle',
    hint = 'Займите исходное положение.';
  let generation = 0,
    lastFrame = -1,
    lastSent = -Infinity,
    capturing = false,
    frameId: number | null = null;
  let cameraOn = false,
    writing = false,
    startedSegment: number | null = null,
    activeBase = 0;
  let restUntil = 0,
    restRemaining = 0,
    wallOrigin = Date.now() - performance.now();
  let newSelection = false;
  let countdownUntil = 0,
    lastPoseAt = -Infinity,
    poseReady = false;
  let lastHoldEnd = 0;
  const current = () => (!newSelection || service.unfinished ? service.record : null);
  let error = '',
    boundEpoch = ctx.session.store.epoch;
  const camera = new Camera(video, () => pause('Камера отключилась. Нажмите «Продолжить».'));
  const vision = new Vision({
    onStatus: (message: string) => {
      if (stage === 'starting') {
        hint = message;
        render();
      }
    },
    onError: (failure: Error) => pause(cameraError(failure)),
    onResult: consume,
  });
  const ticker = setInterval(() => {
    if (['running', 'rest', 'preparing', 'countdown'].includes(stage) && service.expired) {
      pause('Прошло 24 часа. Сохраните частичный результат.');
      return;
    }
    if (stage === 'countdown') {
      if (document.hidden) {
        pause('Программа на паузе: приложение ушло в фон.');
        return;
      }
      if (!poseReady || performance.now() - lastPoseAt > 500) {
        prepareExercise();
        return;
      }
      if (performance.now() >= countdownUntil) enterExercise();
      else {
        hint = 'Приготовьтесь. Начинайте после отсчёта.';
        render();
      }
    }
    if (stage === 'rest') {
      restRemaining = Math.max(0, restUntil - performance.now());
      if (!restRemaining) prepareExercise();
      else {
        hint = `Отдых · ${Math.ceil(restRemaining / 1000)} с`;
        render();
      }
    } else if (stage === 'running' && service.expired)
      pause('Прошло 24 часа. Сохраните частичный результат.');
  }, 200);
  function steps() {
    return selected ? expandWorkoutSteps(selected) : [];
  }
  function stepIndex() {
    const progress = current()?.stepProgress ?? [];
    return steps().findIndex((step, i) => (progress[i] ?? 0) < step.target);
  }
  function elapsed() {
    return Math.floor(
      activeBase + (startedSegment === null ? 0 : Math.max(0, performance.now() - startedSegment)),
    );
  }
  function resetCounters() {
    squat.reset();
    pushup.reset();
    plank.reset();
  }
  function stopCamera() {
    generation++;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    cameraOn = false;
    vision.close();
    camera.stop();
    lease.release();
    wake.release();
    resetCounters();
    lastFrame = -1;
    lastSent = -Infinity;
    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }
  function holdClock() {
    activeBase = elapsed();
    startedSegment = null;
  }
  function pause(message = 'Пауза. Нажмите «Продолжить», когда будете готовы.') {
    if (!['running', 'rest', 'starting', 'preparing', 'countdown'].includes(stage)) return;
    if (stage === 'rest') restRemaining = Math.max(0, restUntil - performance.now());
    holdClock();
    stage = 'paused';
    hint = message;
    stopCamera();
    if (!service.persistenceFailed)
      void service.checkpoint(activeBase).catch(() => {
        error = 'Не удалось сохранить состояние на устройстве. Освободите место и повторите.';
        render();
      });
    render();
  }
  function enterExercise() {
    stage = 'running';
    restRemaining = 0;
    generation++;
    // Preparation never contributes hold time; repetitions keep their calibrated top.
    plank.reset();
    startedSegment ??= performance.now();
    hint = 'Старт! Выполняйте упражнение.';
    schedule();
    render();
  }
  function prepareExercise() {
    holdClock();
    stage = 'preparing';
    countdownUntil = 0;
    poseReady = false;
    lastPoseAt = -Infinity;
    generation++;
    resetCounters();
    hint = 'Займите исходное положение. Затем начнётся отсчёт 3–2–1.';
    schedule();
    render();
  }
  function beginRest() {
    stage = 'rest';
    restRemaining = selected?.restMs ?? 0;
    restUntil = performance.now() + restRemaining;
    resetCounters();
    generation++;
    hint = `Отдых · ${Math.ceil(restRemaining / 1000)} с`;
    render();
  }
  async function start() {
    if (
      ['starting', 'preparing', 'countdown', 'running', 'rest', 'saving'].includes(stage) ||
      writing
    )
      return;
    if (service.authorizationRequired) return;
    service.acknowledgeConflict();
    const attempt = ++generation,
      epoch = ctx.session.store.epoch;
    error = '';
    stage = 'starting';
    hint = 'Подготовка…';
    render();
    try {
      await beforeStart();
      if (attempt !== generation || epoch !== ctx.session.store.epoch) return;
      await service.connect();
      if (attempt !== generation || epoch !== ctx.session.store.epoch) return;
      await service.ensureSupported();
      if (attempt !== generation || epoch !== ctx.session.store.epoch) return;
      if (!current() || current()!.status !== 'active') {
        if (!selected) throw new Error('Выберите программу на экране «Сегодня».');
        await service.start(selected.id);
      }
      if (attempt !== generation || epoch !== ctx.session.store.epoch) return;
      const record = current();
      if (!record || record.pendingEnd)
        throw new Error('Сначала дождитесь сохранения предыдущего результата.');
      if (service.expired)
        throw new Error('Продолжение доступно в течение 24 часов. Сохраните частичный итог.');
      if (ctx.session.state?.activeRound)
        throw new Error('Сначала завершите минутную попытку на другом устройстве.');
      selected = findWorkoutProgram(record.workout.programId);
      newSelection = false;
      if (!selected) throw new Error('Версия программы недоступна.');
      activeBase = record.activeMs;
      startedSegment = null;
      if (!(await lease.acquire()))
        throw new Error('Камера используется другой вкладкой. Освободите её и повторите.');
      if (attempt !== generation || document.hidden) {
        lease.release();
        return;
      }
      const [cameraReady, modelReady] = await Promise.all([
        camera.start('user'),
        vision.load('full'),
      ]);
      if (attempt !== generation || epoch !== ctx.session.store.epoch || document.hidden) {
        stopCamera();
        return;
      }
      if (!cameraReady || !modelReady) throw new Error('Подготовка камеры отменена.');
      // Keep the credential-bound offline profile available for this session's 24h window.
      void rememberWorkoutProfile(ctx.session.state);
      cameraOn = true;
      wallOrigin = Date.now() - performance.now();
      wake.acquire();
      resetCounters();
      lastFrame = -1;
      lastSent = -Infinity;
      if (stepIndex() < 0) {
        await finish('finish');
        return;
      }
      if (restRemaining > 0) {
        stage = 'rest';
        startedSegment = performance.now();
        restUntil = performance.now() + restRemaining;
      } else prepareExercise();
      schedule();
      render();
    } catch (failure) {
      if (epoch !== ctx.session.store.epoch || attempt !== generation) return;
      holdClock();
      stopCamera();
      stage = 'paused';
      error =
        failure instanceof ApiError
          ? errorMessage(failure)
          : failure instanceof Error && !/^[A-Z_]+$/.test(failure.message)
            ? failure.message
            : 'Не удалось запустить программу. Проверьте подключение и повторите.';
      hint = 'Запуск не подтверждён. Повторите, когда будете готовы.';
      render();
    }
  }
  async function finish(action: 'finish' | 'abort') {
    if (stage === 'saving') return;
    holdClock();
    stopCamera();
    stage = 'saving';
    error = '';
    hint = 'Подтверждаем упражнения и итог…';
    render();
    const epoch = ctx.session.store.epoch;
    try {
      await service.end(action, elapsed());
      if (epoch !== ctx.session.store.epoch) return;
      stage = current()?.pendingEnd ? 'saving' : 'ended';
      hint = stage === 'ended' ? 'Результат сохранён.' : 'Ожидаем синхронизацию.';
      void ctx.refresh();
    } catch (failure) {
      if (epoch !== ctx.session.store.epoch) return;
      error =
        failure instanceof Error && !('code' in failure)
          ? failure.message
          : 'Результат ещё не подтверждён. Он сохранён на устройстве; повторите отправку.';
      stage = current()?.pendingEnd ? 'saving' : 'paused';
    }
    render();
  }
  function schedule() {
    if (
      frameId !== null ||
      !cameraOn ||
      !['running', 'rest', 'preparing', 'countdown'].includes(stage)
    )
      return;
    frameId = requestAnimationFrame(frame);
  }
  async function frame(timestamp: number) {
    frameId = null;
    schedule();
    if (
      !['running', 'preparing', 'countdown'].includes(stage) ||
      document.hidden ||
      !cameraOn ||
      !vision.ready ||
      vision.busy ||
      capturing ||
      writing ||
      video.readyState < 2
    )
      return;
    if (video.currentTime === lastFrame || timestamp - lastSent < 50) return;
    lastFrame = video.currentTime;
    const epoch = generation;
    capturing = true;
    try {
      const bitmap = await createImageBitmap(video);
      if (
        epoch !== generation ||
        !['running', 'preparing', 'countdown'].includes(stage) ||
        document.hidden
      ) {
        bitmap.close();
        return;
      }
      lastSent = timestamp;
      vision.detect(bitmap, timestamp, epoch);
    } catch (failure) {
      if (epoch === generation) pause(cameraError(failure));
    } finally {
      capturing = false;
    }
  }
  function consume(data: PoseResult) {
    if (
      !['running', 'preparing', 'countdown'].includes(stage) ||
      data.epoch !== generation ||
      document.hidden ||
      writing ||
      !cameraOn
    )
      return;
    const index = stepIndex(),
      step = steps()[index];
    if (!step) return;
    drawOverlay(canvas, data.landmarks, video.videoWidth || 640, video.videoHeight || 480, true);
    const points = data.landmarks[0],
      w = video.videoWidth,
      h = video.videoHeight;
    let increment = 0,
      incrementMs = 0;
    if (step.exercise === 'squat') {
      const features = squatFeatures(points, w, h, squat.side);
      const value = squat.update(features, data.timestamp);
      increment = value.increment;
      hint = value.hint || value.reason || 'Займите исходное положение.';
      poseReady = features.valid && value.ready && value.phase === 'standing';
    } else if (step.exercise === 'pushup') {
      const value = pushup.update(pushupFeatures(points, w, h, pushup.side), data.timestamp);
      increment = value.increment;
      hint = value.hint || value.reason;
      poseReady = value.tracking && value.phase === 'top';
    } else {
      const value = plank.update(plankFeatures(points, w, h, plank.side), data.timestamp);
      incrementMs = value.incrementMs;
      hint = value.hint || value.reason;
      poseReady = value.tracking && value.phase === 'holding';
    }
    lastPoseAt = data.timestamp;
    if (stage === 'preparing' || stage === 'countdown') {
      if (poseReady && stage === 'preparing') {
        stage = 'countdown';
        countdownUntil = performance.now() + 3000;
      } else if (!poseReady && stage === 'countdown') {
        prepareExercise();
        return;
      }
      if (stage === 'countdown') hint = 'Приготовьтесь. Начинайте после отсчёта.';
      render();
      return;
    }
    if (increment || incrementMs >= 1) {
      const hold =
        step.unit === 'ms'
          ? quantizeHoldInterval(
              wallOrigin,
              data.timestamp,
              incrementMs,
              lastHoldEnd,
              step.target - (current()?.stepProgress[index] ?? 0),
            )
          : null;
      if (step.unit === 'ms' && !hold) {
        render();
        return;
      }
      writing = true;
      const epoch = generation;
      const storeEpoch = ctx.session.store.epoch;
      const occurredAt = hold?.occurredAt ?? Math.floor(wallOrigin + data.timestamp);
      if (hold) lastHoldEnd = hold.occurredAt + hold.durationMs;
      void service
        .recordEvent(index, hold?.durationMs, occurredAt, elapsed())
        .then(async () => {
          if (epoch !== generation || stage !== 'running') return;
          if (stepIndex() !== index) {
            if (stepIndex() < 0) await finish('finish');
            else beginRest();
          }
        })
        .catch(() => {
          if (epoch === generation)
            pause('Не удалось сохранить упражнение на устройстве. Учёт остановлен.');
        })
        .finally(() => {
          if (storeEpoch === ctx.session.store.epoch) writing = false;
          render();
        });
    }
    render();
  }
  function render() {
    if (boundEpoch !== ctx.session.store.epoch) {
      boundEpoch = ctx.session.store.epoch;
      holdClock();
      stopCamera();
      stage = 'idle';
      selected = undefined;
      newSelection = false;
      error = '';
      restRemaining = 0;
      activeBase = 0;
      startedSegment = null;
      writing = false;
      lastHoldEnd = 0;
    }
    if (
      ['starting', 'running', 'rest', 'preparing', 'countdown'].includes(stage) &&
      (service.persistenceFailed || service.authorizationRequired || service.apiUnavailable)
    ) {
      pause(
        service.apiUnavailable
          ? errorMessage(service.availabilityError)
          : service.authorizationRequired
            ? 'Сессия завершилась. Войдите снова; локальные данные сохранены.'
            : service.conflicted
              ? 'Сохранение изменилось в другой вкладке. Учёт остановлен; продолжите с сохранённого состояния.'
              : 'Не удалось сохранить данные на устройстве. Учёт остановлен; освободите место и повторите сохранение.',
      );
    }
    const record = current();
    if (record && startedSegment === null && ['idle', 'paused', 'saving', 'ended'].includes(stage))
      activeBase = Math.max(activeBase, record.activeMs);
    if (record && !selected) selected = findWorkoutProgram(record.workout.programId);
    if (record?.pendingEnd && !['running', 'rest'].includes(stage)) stage = 'saving';
    if (record && record.status !== 'active') stage = 'ended';
    query('title').textContent = selected?.title ?? 'Выберите программу';
    query('lineup').textContent = selected
      ? selected.steps.map(stepLabel).join(' → ')
      : 'Четыре программы доступны на экране «Сегодня».';
    query('body').hidden = !selected;
    query('body').dataset.workoutStage = stage;
    const all = steps(),
      index = stepIndex(),
      step = all[index];
    query('exercise').textContent = step ? EXERCISE_NAMES[step.exercise] : 'Программа закончена';
    query('step').textContent =
      index < 0 ? `${all.length} из ${all.length}` : `Подход ${index + 1} из ${all.length}`;
    const count = record?.stepProgress[index] ?? 0;
    query('count').textContent =
      stage === 'countdown'
        ? String(Math.max(1, Math.ceil((countdownUntil - performance.now()) / 1000)))
        : step
          ? step.unit === 'ms'
            ? `${(count / 1000).toFixed(1)} / ${step.target / 1000} с`
            : `${count} / ${step.target}`
          : '✓';
    query('hint').textContent = record?.pendingEnd
      ? 'Завершение ожидает подтверждения.'
      : service.expired && record?.status === 'active'
        ? 'Продолжение недоступно. Сохраните частичный итог.'
        : hint;
    query('next').textContent =
      index >= 0 && all[index + 1]
        ? `Далее: ${stepLabel(all[index + 1])}`
        : 'Последний подход программы';
    query('time').textContent =
      `Время с отдыхом, без пауз: ${Math.floor(elapsed() / 60000)}:${String(Math.floor(elapsed() / 1000) % 60).padStart(2, '0')}`;
    query('camera-note').hidden = cameraOn;
    query('start').hidden = [
      'running',
      'rest',
      'starting',
      'preparing',
      'countdown',
      'saving',
      'ended',
    ].includes(stage);
    query<HTMLButtonElement>('start').disabled =
      !selected ||
      !ctx.session.state?.profile ||
      service.expired ||
      service.authorizationRequired ||
      service.apiUnavailable;
    query('start').textContent = record ? 'Продолжить' : 'Начать';
    query('pause').hidden = !['running', 'rest', 'starting', 'preparing', 'countdown'].includes(
      stage,
    );
    query('rest-skip').hidden = stage !== 'rest';
    query('stop').hidden = !record || record.status !== 'active' || !!record.pendingEnd;
    query<HTMLButtonElement>('stop').disabled = writing || stage === 'starting';
    query('retry').hidden = service.apiUnavailable || (!record?.pendingEnd && !service.error);
    query<HTMLButtonElement>('retry').disabled = service.saving;
    query('check').hidden = !service.apiUnavailable && !service.availabilityError;
    query<HTMLButtonElement>('check').disabled = service.apiState === 'checking' || service.saving;
    const pending = record?.events.length ?? 0;
    query('status').textContent =
      (service.apiUnavailable ? errorMessage(service.availabilityError) : '') ||
      error ||
      (record?.pendingEnd
        ? 'Завершение ожидает подтверждения. Программа прекращена на устройстве; повторите сохранение после восстановления связи.'
        : service.expired && record?.status === 'active'
          ? '24 часа истекли. Доступно сохранение частичного итога.'
          : service.error || service.availabilityError
            ? errorMessage(service.error || service.availabilityError)
            : pending || service.saving
              ? `Сохраняем упражнения${pending ? `: ${pending}` : ''}…`
              : record
                ? 'Все переданные упражнения подтверждены.'
                : 'Нужен профиль. Камера запускается только по вашей команде.');
    query('result').hidden = stage !== 'ended';
    if (stage === 'ended' && record) {
      const activity = service.activity;
      const totals = { squat: 0, pushup: 0, plank: 0 };
      all.forEach((item, i) => {
        totals[item.exercise] += record.stepProgress[i] ?? 0;
      });
      query('result').innerHTML =
        `<h2>${record.status === 'completed' ? 'Программа выполнена!' : 'Программа завершена досрочно'}</h2><p>Выполненный объём сохранён. ${record.status === 'completed' ? '' : 'Неоконченные цели не засчитаны.'}</p><p>Приседания: ${totals.squat} · отжимания: ${totals.pushup} · планка: ${(totals.plank / 1000).toFixed(1)} с</p><p>Время с отдыхом, без пауз: ${Math.floor(record.activeMs / 60000)}:${String(Math.floor(record.activeMs / 1000) % 60).padStart(2, '0')}</p>${activity ? `<p>Подтверждено сегодня: ${activity.today.xp} XP. Всего ${activity.totalXp} XP · уровень ${activity.level} · серия ${activity.streak.current} дн.</p>` : ''}<button class="button primary" data-workout-new>Выбрать следующую программу</button>`;
      query('result')
        .querySelector('[data-workout-new]')
        ?.addEventListener('click', () => ctx.navigate('today'), { once: true });
    }
  }
  query('start').onclick = () => void start();
  query('pause').onclick = () => pause();
  query('rest-skip').onclick = () => {
    restRemaining = 0;
    prepareExercise();
  };
  query('stop').onclick = () => void finish('abort');
  const retry = async () => {
    const epoch = ctx.session.store.epoch;
    try {
      await service.connect();
      await service.retry();
      if (epoch !== ctx.session.store.epoch) return;
      error = '';
      if (!current()) stage = 'idle';
      else if (current()?.status !== 'active') stage = 'ended';
    } catch (failure) {
      if (epoch !== ctx.session.store.epoch) return;
      error = errorMessage(failure);
    }
    render();
  };
  query('retry').onclick = () => void retry();
  query('check').onclick = () => void retry();
  query('back').onclick = () => ctx.navigate('today');
  return {
    render,
    select(programId?: string) {
      if (service.unfinished) selected = findWorkoutProgram(current()!.workout.programId);
      else {
        selected = findWorkoutProgram(programId ?? 'starter-circuit-v1');
        newSelection = true;
      }
      if (!['running', 'rest', 'preparing', 'countdown'].includes(stage)) {
        stage = 'idle';
        hint = 'Нажмите «Начать», чтобы включить камеру.';
        error = '';
      }
      render();
    },
    pause,
    get cameraOn() {
      return cameraOn || stage === 'starting';
    },
    get busy() {
      return writing || stage === 'starting';
    },
    get running() {
      return ['running', 'rest', 'preparing', 'countdown'].includes(stage);
    },
    destroy() {
      holdClock();
      stopCamera();
      clearInterval(ticker);
    },
  };
}
