const MESSAGES = Object.freeze({
  SIGN_IN_REQUIRED: 'Войдите в профиль, чтобы сохранить результат.',
  STORAGE_UNAVAILABLE: 'Серверное хранилище временно недоступно. Повторите позже.',
  METHOD_NOT_ALLOWED: 'Обновите приложение и повторите действие.',
  INVALID_INPUT: 'Проверьте данные и повторите действие.',
  INVALID_ID: 'Не удалось отправить данные. Обновите страницу.',
  INVALID_NAME: 'Укажите имя от 1 до 40 символов.',
  INVALID_TIME_ZONE: 'Часовой пояс не распознан. Проверьте настройки устройства.',
  INVALID_EVENT_TIME: 'Не удалось подтвердить время повторений. Проверьте дату и время устройства; данные сохранены для повторной отправки.',
  ROUND_NOT_FOUND: 'Раунд не найден или недоступен.',
  INVALID_ROUND_TIME: 'Время повторения не относится к этому раунду. Данные требуют проверки.',
  ROUND_INTERRUPTED: 'Раунд прерван. Сохранённые повторения остаются в дневном задании.',
  REQUEST_REUSED: 'Этот запрос уже использовался для другого действия. Обновите страницу.',
  COMPETITION_NOT_FOUND: 'Соревнование не найдено или недоступно.',
  INVITATION_PENDING: 'Друг ещё не принял приглашение.',
  INCOMPATIBLE_RULES: 'Правила соревнования отличаются. Обновите приложение перед попыткой.',
  COMPETITION_CLOSING: 'До конца соревнования осталось меньше минуты.',
  ATTEMPTS_EXHAUSTED: 'Все три попытки уже использованы.',
  START_CONFLICT: 'Не удалось начать раунд. Проверьте другие вкладки и повторите.',
  ROUND_RUNNING: 'Минута ещё не закончилась. Дождитесь завершения таймера.',
  INVITATION_NOT_FOUND: 'Приглашение не найдено или уже недоступно.',
  AUTH_REQUIRED: 'Войдите в профиль, чтобы сохранить результат.',
  UNAUTHORIZED: 'Войдите в профиль, чтобы продолжить.',
  FORBIDDEN: 'У вас нет доступа к этим данным.',
  NOT_FOUND: 'Запись не найдена или недоступна.',
  PROFILE_REQUIRED: 'Сначала создайте профиль.',
  INVALID_PROFILE: 'Проверьте имя и часовой пояс профиля.',
  INVALID_REQUEST: 'Не удалось отправить данные. Обновите страницу и повторите.',
  INVALID_EVENTS: 'Некоторые повторения требуют проверки. Данные сохранены на устройстве.',
  INVALID_EVENT: 'Повторение не подтверждено сервером. Данные сохранены на устройстве.',
  EVENT_CONFLICT: 'Это повторение уже отправлялось с другими данными. Требуется проверка.',
  INVALID_INVITATION: 'Приглашение недействительно или уже недоступно.',
  INVITATION_TAKEN: 'Это приглашение уже принял другой участник.',
  INVITATION_CANCELLED: 'Автор отменил приглашение. Попросите новую ссылку.',
  INVITATION_ACCEPTED: 'Друг уже принял вызов. Принятую дуэль отменить нельзя.',
  SELF_INVITATION: 'Нельзя принять собственное приглашение.',
  COMPETITION_NOT_ACTIVE: 'Соревнование ещё не началось или уже завершилось.',
  COMPETITION_EXPIRED: 'Срок соревнования истёк.',
  ATTEMPT_LIMIT: 'Все три попытки уже использованы.',
  TOO_LATE: 'До конца соревнования осталось меньше минуты.',
  ACTIVE_ROUND: 'У вас уже идёт раунд. Завершите его в другой вкладке или на другом устройстве.',
  ROUND_ACTIVE: 'У вас уже идёт раунд на другом устройстве или в другой вкладке.',
  ROUND_TOO_EARLY: 'Минута ещё не закончилась. Дождитесь завершения таймера.',
  ROUND_EXPIRED: 'Раунд прерван: результат не получен вовремя.',
  ROUND_NOT_ACTIVE: 'Раунд уже завершён или прерван.',
  RULES_MISMATCH: 'Версия правил изменилась. Обновите страницу перед новым раундом.',
  ORIGIN_FORBIDDEN: 'Откройте приложение по его прямой ссылке.',
  NETWORK: 'Нет связи с сервером. Данные на устройстве будут отправлены повторно.',
  TIMEOUT: 'Сервер не ответил вовремя. Повторная отправка безопасна.',
  LOCAL_STORAGE: 'Не удалось сохранить данные на устройстве. Освободите место и повторите попытку.',
  OUTBOX_CONFLICT: 'Локальные данные повторения не совпали. Требуется проверка.',
  SERVER_ERROR: 'Не удалось сохранить данные на сервере. Повторная отправка безопасна.',
});

export class ApiError extends Error {
  constructor(code = 'SERVER_ERROR', status = 0) {
    const normalized = String(code).toUpperCase();
    const userMessage = MESSAGES[normalized] || (status === 401 ? MESSAGES.AUTH_REQUIRED : status === 403 ? MESSAGES.FORBIDDEN : status === 404 ? MESSAGES.NOT_FOUND : MESSAGES.SERVER_ERROR);
    super(userMessage);
    this.name = 'ApiError'; this.code = normalized; this.status = status; this.userMessage = userMessage;
  }
}

export function getTestUser() {
  try {
    return localStorage.getItem('movement.testUser') || '';
  } catch {
    return '';
  }
}

export function setTestUser(name) {
  try {
    if (name) localStorage.setItem('movement.testUser', name.trim());
    else localStorage.removeItem('movement.testUser');
  } catch {}
}

export function getTestUserId(name) {
  if (!name) return '';
  const bytes = new TextEncoder().encode(name.trim().toLowerCase());
  return 'u_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function getApiBaseUrl() {
  if (typeof window !== 'undefined' && (window.Capacitor?.isNativePlatform?.() || window.location.protocol === 'capacitor:')) {
    return 'https://ais-pre-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app/api';
  }
  return '/api';
}

export async function api(path, {method = 'GET', body, keepalive = false} = {}) {
  const relative = String(path).replace(/^\/api\/?/, '').replace(/^\//, '');
  if (!relative || relative.includes('://') || relative.startsWith('//') || relative.includes('..')) throw new ApiError('INVALID_REQUEST', 400);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const testUser = getTestUser();
    const testUserId = getTestUserId(testUser);
    const headers = {
      Accept: 'application/json',
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(testUserId ? {'x-test-user-id': testUserId} : {})
    };
    const baseUrl = getApiBaseUrl();
    const isCross = baseUrl.startsWith('http');
    const response = await fetch(`${baseUrl}/${relative}`, {
      method, credentials: isCross ? 'include' : 'same-origin', cache: 'no-store', keepalive,
      headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(data?.error?.code || data?.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'SERVER_ERROR'), response.status);
    if (!data || typeof data !== 'object') throw new ApiError('SERVER_ERROR', response.status);
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
  } finally { clearTimeout(timeout); }
}
