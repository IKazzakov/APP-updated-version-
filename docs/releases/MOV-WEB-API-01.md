# MOV-WEB-API-01 — браузерный доступ к единственному API

Статус: **NOT_DEPLOYED**. Исходная база `main` —
`6733f9703a2588dd2978bdd5059fc763f943bb28` (2.6.1). Схема, бизнес-JSON,
Bearer, данные и версия не меняются. Реальный доступ полного браузерного клиента
зависит от отдельного разрешения выпуска и проверки фактического Pages alias.

## Изменение HTTP

Публичный Worker принимает только канонический Origin
`https://preview-<16 lowercase hex>.movement-preview.pages.dev`. Для валидного
`OPTIONS /api/*` возвращает 204, пустое тело и `Allow-Origin` с проверенным
Origin, `Allow-Methods: GET, HEAD, POST`, `Allow-Headers: Authorization, Content-Type`,
`Max-Age: 300`, `Cache-Control: no-store` и `Vary` по Origin, requested method и
headers. Чужой Origin получает 403 без allow-заголовков; неверный method/header
при допустимом Origin — читаемый 400 `INVALID_PREFLIGHT`. В ответах GET/HEAD/POST
добавлены `Allow-Origin` и `Vary: Origin`, включая ошибки. Credentials не разрешены.

Допуск доходит до business Origin guard в виде непрозрачного подтверждения,
привязанного к конкретному окончательному Request. Это не удостоверяет пользователя
и не изменяет Bearer, JSON, ownership или SQL. Sites и Node сохраняют прежнее
same-origin поведение; Node использует тот же Worker-адаптер с `STORAGE_KIND=sqlite`.
Миграций нет, API-base и wire-типы прежние. Подробности — в `docs/API.md` и
`docs/API_ORIGIN_ADAPTER_CONTRACT.md`.

## Проверки

- `node --test tests/browser-origin.test.js tests/api-origin-context.test.js tests/cloudflare.test.js` — локальная SQLite; реальные адаптеры Cloudflare, Sites и Node.
- `node --check` для изменённых JS-файлов, `npm run format:check`, `git diff --check`.
- `npm run backend:validate` — локальная упаковка Worker в dry-run.

CI PR остаётся обязательным. На реальном API/D1 тестовые профили и действия не
создавались. Доступ телефона, полный браузерный клиент и опубликованный alias этими
проверками не подтверждены.

## Последующая активация и откат

Тимлид сверяет backend с результатом Frontend; merge и выпуск Worker выполняются
только после отдельной прямой команды владельца. Миграций и удалений данных нет.
После разрешённого выпуска проверить фактический HTTPS alias и без записи выполнить
health, допустимый OPTIONS и анонимный GET с читаемым `401 DEVICE_AUTH_REQUIRED`.
Guest/profile/repetitions/finish/abort и тестовые профили в рабочем API не создавать.

При необходимости откатить Worker на предыдущую проверенную версию, убрав только
новое правило допуска; существующую D1, сессии, профили и записи не удалять и не
создавать новую БД. До разрешённого выпуска и проверки этот пакет остаётся
**NOT_DEPLOYED**.
