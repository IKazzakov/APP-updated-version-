# MOV-WEB-API-01 — доступ полного браузерного клиента к единственному API

## Роль, один результат и база

Ты — Backend + БД «Движения», новый отдельный тред, без внутреннего делегирования.
Одна цель: позволить обычному браузеру с доверенного alias movement-preview
использовать существующий API с прежней Bearer-авторизацией.
Новых бизнес-функций, сервера или схемы нет.

- Repo: https://github.com/rojoscarlos-cpu/APP-updated-version-.
- Main/base: `6733f9703a2588dd2978bdd5059fc763f943bb28`, tree `053449289afdc94e0f0085df444fa91f759fc85e`, /2.6.1.
- Ветка `codex/mov-web-api-01-20261029`; PR target **main**.
- До работы проверить актуальный main/HEAD/status/версии. Начальный docs-only
  коммит постановки сохраняется; чужие изменения не сбрасывать.
- Полный [контракт](../WEB_APP_CONTRACT.md) обязателен, включая точный regex Origin,
  preflight/ошибки/ответы/сохранность/порядок выпуска. Если найдена несовместимость,
  вернуть её Тимлиду, не менять правило молча.
- [AGENTS](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/AGENTS.md), [TEAM_CONTEXT](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/TEAM_CONTEXT.md), [DEVELOPMENT](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/DEVELOPMENT.md), [WEB_PREVIEW](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/WEB_PREVIEW.md), [TASK_TEMPLATE](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/team/TASK_TEMPLATE.md). Инструкции PR24 ещё не в main; прочитать именно этот ref.

## Чтение по задаче

[Backend](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/team/BACKEND.md),
[API](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/6733f9703a2588dd2978bdd5059fc763f943bb28/docs/API.md),
[SINGLE_SERVER](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/6733f9703a2588dd2978bdd5059fc763f943bb28/docs/SINGLE_SERVER.md),
[DATA_MODEL](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/6733f9703a2588dd2978bdd5059fc763f943bb28/docs/DATA_MODEL.md),
[HANDOFF](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/6733f9703a2588dd2978bdd5059fc763f943bb28/docs/team/HANDOFF.md).
Целевое чтение: server/cloudflare.js, device-auth.js, api.js;
wrangler.backend.json и scripts/deploy-backend.mjs только контракт настройки;
tests/cloudflare.test.js. Wire src/shared/contracts/api.ts и validate.ts read-only.
Миграции неизменны; не обходить весь клиент/алгоритмы.

## Изменение и контракт

Вынести локальную классификацию browser Origin/preflight в новый
`server/browser-origin.js`, подключить в `server/cloudflare.js`.
Точный доверенный Pages project regex и все входы/выходы/ошибки — в WEB_APP_CONTRACT.
Изменяется только транспортный HTTP-контракт; все бизнес-JSON, auth/ownership,
UUID/idempotency, лимиты, revision/pagination и SQLite остаются прежними.
Allow-Origin отражается только после проверки; отказ до body/D1.
Для допустимого preflight D1 не нужна. CORS присутствует и на читаемом401/ошибках.
Нельзя включать cookies, доверять Origin как идентичности или Sites/test headers.
Прежние native/same-origin допуски не сужать и не расширять за пределами контракта.

## Файлы и владельцы

Единственный Backend владеет:
- новый server/browser-origin.js;
- server/cloudflare.js — только Origin/preflight и CORS wrapping API responses;
- новый tests/browser-origin.test.js, tests/cloudflare.test.js — затронутые сценарии;
- docs/API.md — полное HTTP-расширение в том же PR;
- docs/releases/MOV-WEB-API-01.md — результат/план активации/откат.

Все остальные файлы read-only. Общие api.ts/validate.ts не меняются: JSON совместим.
Если реально нужен новый JSON — остановить это расширение и вернуть точный diff
Тимлиду; не делить контракт с Frontend. server/api.js/device-auth.js/SQL, пакет/
ключ/API-base Android, начисления, runtime, deployment workflows не редактировать.
Версии не поднимать в этом пакете.

## Критерии и адресные проверки

1. node --test tests/browser-origin.test.js tests/cloudflare.test.js:
   допустимый canonical alias; точные204 headers; case-insensitive header subset;
   badOrigin/null/http/credentials/port/path/suffix/immutable/apex/method/header
   negatives; читаемые401/validation errors; no DB for OPTIONS.
2. На реальном существующем обработчике + отдельной SQLite:
   anonymous401; guest/profile; Bearer не даёт чужого профиля; чужойOrigin403
   без записи; повторы запроса остаются идемпотентны; прежний same-origin/native
   и existing cloudflare regressions проходят.
3. Syntax/format/diff; существующий backend dry-run один раз для упаковки
   нового import. Остальные тесты — только при найденной регрессии;
   обязательный CI сохраняется. Не повторять вручную весь npm test/браузеры/APK.
4. Документирован заголовочный diff, API.md, команды и будущий безопасный smoke.
   До remote активации честный NOT_DEPLOYED, а не «API готов».
   План отката удаляет только новое правило допуска без удаления данных.

## Зависимости, интеграция, передача

Frontend независимо готовит полную статическую сборку в MOV-WEB-APP-01;
фактический alias проверит после размещения. Сервер разрешает только закреплённый
класс контролируемых alias проекта, не весь pages.dev.
Вернуть PR/head/base SHA, контрактный diff, адресные проверки и ограничения.
Тимлид сопоставляет с Frontend, затем отдельно оформляет owner-команду на
merge/deploy готового решения. Не применять remote SQL и не публиковать Worker
самостоятельно. Локальные тестовые данные не попадают в рабочий API/D1.

Связанное полное [ТЗ Frontend](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/codex/mov-web-app-01-20261029/docs/tasks/MOV-WEB-APP-01.md).
