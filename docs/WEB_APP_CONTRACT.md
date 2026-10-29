# MOV-WEB-01 — полное приложение в браузере и доступ к API

Решение Тимлида от 29 октября 2026 года по запросу владельца: нужен полный
существующий клиент в браузере. Статический exercise-harness PR29 остаётся
вспомогательным инструментом; его успех не равен готовности полного приложения.
Это контракт реализации, не разрешение main merge/выпуска основного API.

## Базы и два небольших результата

- Backend MOV-WEB-API-01: main `6733f9703a2588dd2978bdd5059fc763f943bb28` /2.6.1.
- Frontend MOV-WEB-APP-01: PR29 `8d66479289996d7d7e5966764a166312be0df7c2`,
  tree `a0d5412e72b96701bd4448f250fecd5443aac905` /2.6.3.
- Frontend branch `codex/mov-web-app-01-20261029`, target
  `codex/mov-core-02b-20261028`. Backend branch
  `codex/mov-web-api-01-20261029`, target main.
- Рабочие ветки содержат собственное полное docs/tasks/<ID>.md.
- Сначала совместимый HTTP-контракт; разработка может идти независимо.
  Полная live-приёмка браузера зависит от отдельно разрешённого выпуска Backend.
  Неприменённый серверный PR не считается готовым API.
- Внутренние подагенты и автоматический запуск исполнителей не разрешены.

## Полный клиент

Используются index.html → src/main.js → src/app/bootstrap.ts/registry.ts и все
существующие views/controllers/services: Сегодня, Тренировка (программы и
обычные режимы), Прогресс, Соревнования/дуэли/недельные рейтинги,
Профиль/явный гостевой вход, общая Диагностика.
Светлый дизайн, навигация, общий ExerciseRuntime/Full и хранилища сохраняются.
Отдельная реализация экранов и перенос только workout view не допускаются.

Pages публикует только статический клиент. Ни Functions, ни server API/Worker/D1,
ни прокси для подмены Origin там нет. API единственный:
**https://movement-test-api-staging.rojoscarlos93.workers.dev/api**. Его адрес в web-preview задаётся явно;
обычные web/Android сборки и сохранённые Android настройки не переписываются.
Фактический getApiBaseUrl() в этом режиме должен возвращать полный адрес, а не
локальный /api на Pages.

Режим этой задачи: dataMode=real, apiMode=real, poseMode=camera.
Видимая/копируемая диагностика показывает это и реальный API-base, appVersion,
previewVersion, полный source/tree SHA, dirty, branchRef, builtAt, schemaVersion1.
Код из src/preview/fixtures, synthetic controls и тестовые личности не включаются
в полную real-сборку. Ошибка API не заменяется demo-профилем/XP/успехом.
Изолированный harness PR29 остаётся isolated/none/null без ослабления его правил.

Стабильный адрес новой ветки, рассчитанный существующей схемой полного branchRef:
`https://preview-67f2889c80972c44.movement-preview.pages.dev`.
Это **зарезервированный ожидаемый alias**, а не уже опубликованная ссылка.
deploymentBranch = preview- + первые16 hex SHA-256 полного
`refs/heads/codex/mov-web-app-01-20261029`.
Факт URL/SHA/HTTPS/доступа подтверждается только после публикации.

## HTTP/CORS-контракт единственного API

Сейчас docs/API.md требует same-site Origin для POST; публичный обработчик
использует 403 ORIGIN_FORBIDDEN. CORS-разрешения для Pages в контракте отсутствуют.
Это явное совместимое расширение, не удаление прежнего Origin guard.

Дополнительный доверенный класс Origin — **только** полное каноническое значение,
соответствующее выражению:
`^https://preview-[0-9a-f]{16}\.movement-preview\.pages\.dev$`.
Это контролируемые alias одного Pages-проекта movement-preview.
Обычные same-origin/native/Origin-absent допуски остаются ровно прежними.
Не разрешаются весь pages.dev, произвольные поддомены проекта, immutable
deployment URLs, apex, http, порт, путь/query/fragment, credentials, null,
поддельные suffix и похожие домены. Никаких Access-Control-Allow-Origin:*.
Источник разрешённого проекта фиксируется в коде/PR, не берётся из запроса.

Валидный preflight:
- OPTIONS /api/*, Origin из этого класса;
- Access-Control-Request-Method: GET, HEAD или POST;
- Access-Control-Request-Headers: только Authorization и/или Content-Type,
  сравнение имён регистронезависимое; пустой список допустим.
- Ответ **204**, пустое тело; Access-Control-Allow-Origin равен проверенному
  Origin, Allow-Methods: GET, HEAD, POST; Allow-Headers: Authorization, Content-Type;
  Max-Age:300; Cache-Control:no-store;
  Vary включает Origin, Access-Control-Request-Method, Access-Control-Request-Headers.
- Авторизация, D1 и бизнес-мутации для OPTIONS не вызываются.
- Неверный/чужой Origin:403 {error:{code:"ORIGIN_FORBIDDEN"}}, без CORS allow headers.
- Разрешённый Origin, но неверный requested method/headers:400
  {error:{code:"INVALID_PREFLIGHT"}}; разрешённый Origin читаем через CORS.
  Это единственный новый error code; ApiErrorBody.code уже string.

GET/HEAD/POST /api/* с допустимым Pages Origin идут в прежнюю маршрутизацию.
Access-Control-Allow-Origin:<этот Origin> и Vary:Origin добавляются к успешным
и ошибочным ответам, включая 400/401/404/409/429/500, без изменения JSON/status/cache.
Access-Control-Allow-Credentials не включать: авторизация по Bearer, не cookies.
Origin проверяется и на фактическом запросе независимо от preflight cache.
Чужой POST сохраняет 403 ORIGIN_FORBIDDEN до бизнес-записи.

GET/HEAD health остаются публичными по прежнему контракту. До явного входа
бизнес-запросы дают читаемый 401 DEVICE_AUTH_REQUIRED. Guest/profile/logout,
repetitions, workout sync/finish/abort, страницы истории и соревнования сохраняют
прежние auth, body, JSON, HTTP-коды, идемпотентность UUID, pagination/version.
Новый Origin не задаёт userId/профиль и не разрешает Sites/test identity headers.

Изменение API.md — в том же Backend PR. Wire-типы и validators JSON не меняются:
схемы успешных ответов те же; ApiErrorBody уже принимает code:string.
Backend — единственный владелец HTTP-контракта этой правки; Frontend wire read-only.

## Сохранность и реальные данные

Browser origin имеет собственное хранилище/явную гостевую сессию; профиль/ключ
Android не копируются и не объединяются по отображаемому имени.
Стабильный alias сохраняется при обновлении этой ветки; перенос ветки на другой
origin не выдаётся за бесшовный перенос браузерного профиля.
Работают прежние UUID-before-send, очереди, pendingEnd, partial ACK и ACK-before-end.
Смена профиля/сети/reload не удаляет неподтверждённые данные.

В production API записываются только реальные действия владельца в real-сборке.
Автотесты с fake media/позами/профилями используют отдельный локальный API/SQLite
или явный перехват в изолированном браузерном fixture. Не создавать
автотестовые профили/результаты/XP в рабочей D1.
Live smoke до действий владельца: anonymous page, health/OPTIONS/GET→401;
не guest/profile/repetitions/finish/abort и не запись в реальные данные.

## Приёмка и выпуск

Полный app UI/навигация/авторизация/ошибки/пауза/recovery проверяются адресно
на полном клиенте; два viewport393×852 и852×393, source screenshots/manifest.
Изолированный сквозной тест покрывает guest/profile, разделы, программу,
reload/offline/очередь и повторную доставку без дублей; не перепроверяет
физическую точность счётчика.
После разрешённого выпуска API live browser должен прочитать401, а не
получить непрозрачный CORS/HTML ответ. До этого статус API_DEPLOY_PENDING;
полное live-приложение не объявлять готовым.

Ссылка, app/previewVersion, полный source/tree/dirty, API/data/pose режим,
результаты, ограничения и фактическое обновление alias сохраняются в отчёте.
Нет обещания новой доступной ссылки/автообновления до проверки.
APK сейчас не нужен; Android camera/permissions/performance/update проверяются
на отдельном согласованном этапе. Известный initial-pose pushup дефект не закрывается
веб-сборкой. Алгоритмы не меняются этими пакетами.

Основной API/deploy, main merge и D1 изменения требуют отдельной прямой команды
после готового кода/проверок. Настоящий HTTP/CORS код сначала должен быть
reviewable в PR; разрешение на его выпуск заранее не запрашивается.
