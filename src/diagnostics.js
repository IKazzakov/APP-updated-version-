import { activity } from './activity-log.js';
import { VERSION, VISION_VERSION, RULES_VERSION, MODELS } from './config.js';

const ERRORS = new Set([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NETWORK',
  'TIMEOUT',
  'LOCAL_STORAGE',
  'INVALID_EVENT',
  'SERVER_ERROR',
  'CAMERA_DENIED',
  'CAMERA_UNAVAILABLE',
  'CAMERA_ENDED',
  'MODEL_LOAD',
  'MODEL_RUNTIME',
  'ROUND_ABORTED',
  'SAVE_FAILED',
  'UNKNOWN_ERROR',
  'ROUND_START_FAILED',
  'START_POSE_LOST',
]);
const ERROR_NAMES = {
  NotAllowedError: 'CAMERA_DENIED',
  SecurityError: 'CAMERA_DENIED',
  NotFoundError: 'CAMERA_UNAVAILABLE',
  NotReadableError: 'CAMERA_UNAVAILABLE',
};
const CONNECTION_CODES = [
  'NOT_CHECKED',
  'OK',
  'AUTH_REQUIRED',
  'SIGN_IN_REQUIRED',
  'DEVICE_AUTH_REQUIRED',
  'SESSION_REVOKED',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'STORAGE_UNAVAILABLE',
  'API_NOT_FOUND',
  'API_RESPONSE_INVALID',
  'NETWORK',
  'TIMEOUT',
  'SERVER_ERROR',
  'ORIGIN_FORBIDDEN',
];
const enumValue = (value, options, fallback = null) => (options.includes(value) ? value : fallback);
const number = (value, maximum) =>
  Number.isFinite(value) && value >= 0 && value <= maximum ? Math.round(value * 10) / 10 : null;

function browserDescription() {
  const ua = globalThis.navigator?.userAgent || '';
  const match = ua.match(/(Chrome|Firefox|Edg|Version)\/(\d+(?:\.\d+){0,3})/);
  const platform = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Не определена';
  return {
    name: match ? { Edg: 'Edge', Version: 'Safari' }[match[1]] || match[1] : 'Не определён',
    version: match?.[2] || null,
    platform,
    mobile: /Mobile|Android|iPhone|iPad/i.test(ua),
  };
}

export class Diagnostics {
  constructor() {
    this.values = {};
    this.errors = [];
    this.startEvents = [];
    this.lastTransition = null;
  }
  startEvent(status, requestMs = null) {
    if (!['requesting', 'confirmed', 'rejected', 'cancelled'].includes(status)) return;
    activity.record('round.start', { stage: status, ms: requestMs });
    this.startEvents.push({
      at: new Date().toISOString(),
      status,
      requestMs: number(requestMs, 60000),
    });
    this.startEvents = this.startEvents.slice(-8);
  }
  update(state = {}) {
    // Do not spread engine, API, profile or session objects into a report.
    const transition = {
      mode: state.mode,
      camera: !!state.cameraOn,
      ready: !!state.ready,
      paused: !!state.paused,
      phase: state.phase,
      stage: state.roundStatus,
    };
    const key = JSON.stringify(transition);
    if (key !== this.lastTransition) {
      activity.record('training.changed', transition);
      this.lastTransition = key;
    }
    this.values = {
      apiConnection: {
        status: number(state.apiConnection?.status, 599),
        code: enumValue(state.apiConnection?.code, CONNECTION_CODES),
      },
      mode: enumValue(state.mode, ['practice', 'personal', 'competition']),
      camera: state.cameraOn ? 'Включена' : 'Выключена',
      facing: enumValue(state.facing, ['user', 'environment']),
      model: MODELS.full.name,
      modelStatus: /ошиб/i.test(state.modelStatus || '')
        ? 'Ошибка загрузки'
        : state.modelStatus === 'Готово'
          ? 'Готово'
          : /^Загрузка модели/.test(state.modelStatus || '')
            ? 'Загрузка модели'
            : 'Не запущена',
      ready: state.ready === true,
      paused: state.paused === true,
      phase: enumValue(state.phase, ['baseline', 'standing', 'descending', 'bottom']),
      roundStatus: enumValue(state.roundStatus, [
        'idle',
        'preparing',
        'running',
        'completed',
        'interrupted',
      ]),
      preparationStatus: enumValue(state.preparationStatus, [
        'idle',
        'loading',
        'waiting',
        'countdown',
        'starting',
        'running',
        'completed',
        'error',
      ]),
      soundEnabled: state.soundEnabled === true,
      soundAvailable: state.soundAvailable === true,
      resolution:
        typeof state.resolution === 'string' &&
        /^\d{2,5}\s*[×x]\s*\d{2,5}(?:\s*@\s*\d+(?:[.,]\d+)?\s*(?:fps|кадров\/с))?$/iu.test(
          state.resolution,
        )
          ? state.resolution
          : null,
      fps: number(state.fps, 240),
      inferenceMs: number(state.inferenceMs, 60000),
    };
  }
  error(value) {
    const raw = typeof value === 'string' ? value : value?.code || value?.name;
    const code = ERRORS.has(raw) ? raw : ERROR_NAMES[raw] || 'UNKNOWN_ERROR';
    activity.record('app.error', { code });
    this.errors.push({ at: new Date().toISOString(), code });
    this.errors = this.errors.slice(-12);
  }
  report() {
    return {
      app: 'Счётчик упражнений',
      version: VERSION,
      rulesVersion: RULES_VERSION,
      vision: VISION_VERSION,
      report: 'squat-support-v1',
      createdAt: new Date().toISOString(),
      browser: browserDescription(),
      secureContext: globalThis.isSecureContext === true,
      ...this.values,
      startEvents: this.startEvents.map((event) => ({ ...event })),
      errors: this.errors.map((error) => ({ ...error })),
      activity: activity.snapshot(),
    };
  }
  reportText() {
    return JSON.stringify(this.report(), null, 2);
  }
}
