import { dom } from '../../shared/dom.ts';
import type { TrainingState } from '../../training.js';
import type { TrainingMode } from '../../shared/contracts/api.ts';
import type { PreparationStatus } from '../../round-preparation.js';
export interface TrainingViewModel {
  mode: TrainingMode;
  busy: boolean;
  roundSaving: boolean;
  localPracticeSession: boolean;
  hasProfile: boolean;
  outboxReady: boolean;
  preparation: { pending: boolean; status: PreparationStatus; number: number | null };
  visualSignal: { message: string; until: number } | null;
  sound: { enabled: boolean };
  errorMessage: string;
}
export function createTrainingView(root: HTMLElement) {
  const { get: $, text } = dom(root);
  return {
    render(s: TrainingState, vm: TrainingViewModel) {
      const {
        mode,
        busy,
        roundSaving,
        localPracticeSession,
        outboxReady,
        preparation,
        visualSignal,
        sound,
      } = vm;
      const state = vm.hasProfile ? { profile: true } : null;
      text('count', s.count);
      $('count').setAttribute('aria-label', `Повторений: ${s.count}`);
      text('camera-status', s.starting ? 'Подготовка камеры…' : s.cameraStatus);
      $('camera-empty').hidden = s.cameraOn;
      $('video-layer').classList.toggle('mirror', s.facing === 'user');
      text('facing-label', s.facing === 'user' ? 'Передняя камера · зеркало' : 'Задняя камера');
      const timed = mode !== 'practice',
        running = s.roundStatus === 'running';
      const localPractice = localPracticeSession || !state?.profile || !outboxReady;
      $('local-practice-note').hidden = !localPractice;
      text(
        'local-practice-note',
        timed
          ? 'Минутные раунды и дуэли требуют подключения к профилю. Выберите «Обычная тренировка», чтобы проверить камеру.'
          : 'Проверка без профиля: камера и счётчик работают. Повторения этого теста не сохраняются и не отправляются на сервер.',
      );
      const preparing = timed && preparation.pending,
        ps = preparation.status;
      text(
        'state',
        ps === 'error'
          ? 'Запуск не подтверждён'
          : ps === 'starting'
            ? 'Подтверждаем запуск…'
            : ps === 'countdown'
              ? 'Положение определено'
              : ps === 'waiting'
                ? 'Ожидаем исходное положение'
                : s.paused
                  ? 'Пауза'
                  : s.starting
                    ? 'Загрузка модели'
                    : s.reason,
      );
      text(
        'hint',
        preparing
          ? s.poseReady
            ? 'Встаньте в кадр в исходное положение. Отсчёт начнётся автоматически'
            : s.hint
          : s.hint,
      );
      const announcement =
        visualSignal && performance.now() < visualSignal.until ? visualSignal.message : null;
      $('countdown').hidden = ps !== 'countdown' && ps !== 'starting' && !announcement;
      text(
        'countdown',
        ps === 'starting'
          ? 'Ждём подтверждения'
          : ps === 'countdown'
            ? preparation.number
            : announcement || '',
      );
      $('preparation-status').hidden = !preparing && ps !== 'error';
      $('preparation-status').classList.toggle('failed', ps === 'error');
      text(
        'preparation-status',
        (ps === 'error'
          ? vm.errorMessage ||
            'Сервер не подтвердил запуск. Нажмите «Подготовиться», чтобы повторить.'
          : ps === 'countdown'
            ? `Положение определено · ${preparation.number}`
            : ps === 'starting'
              ? 'Ждём подтверждения сервера. Начинайте только после сигнала «Старт».'
              : 'Встаньте в кадр в исходное положение. Отсчёт начнётся автоматически') +
          (sound.enabled && /недоступен|приостановил|Не удалось/.test($('sound-status').textContent)
            ? ' · Звук недоступен: следите за экраном.'
            : ''),
      );
      text('model-status', `Pose Landmarker Full · ${s.modelStatus}`);
      $('timer').hidden = !timed;
      const sec = Math.ceil(Math.max(0, s.timerMs) / 1000);
      text('timer', `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
      $('pause').hidden = timed;
      $('reset').hidden = timed;
      $('pause').disabled = !s.cameraOn || s.starting || busy;
      $('reset').disabled = busy || s.starting;
      text('pause', s.paused ? 'Продолжить' : 'Пауза');
      $('early-stop').hidden = !running;
      $('early-stop').disabled = busy;
      $('stop').disabled = !s.cameraOn && !s.starting;
      $('switch-camera').disabled = running || preparing || busy || s.starting;
      $('practice-mode').disabled = running || preparing || roundSaving;
      $('personal-mode').disabled = running || preparing || roundSaving;
      $('start').hidden = running || preparing;
      $('cancel-preparation').hidden = !preparing;
      $('sound-controls').hidden = !timed;
      $('start').disabled =
        busy ||
        roundSaving ||
        s.starting ||
        (timed && localPractice) ||
        (!timed && s.cameraOn && !s.paused);
      text(
        'start',
        roundSaving
          ? 'Сохраняем результат…'
          : timed
            ? 'Подготовиться'
            : !s.cameraOn
              ? 'Начать'
              : 'Продолжить',
      );
    },
  };
}
