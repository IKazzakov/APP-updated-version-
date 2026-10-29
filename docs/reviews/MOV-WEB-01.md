# MOV-WEB-01 — архитектурное заключение Тимлида

Сверка 29 октября 2026 года. Роль: Тимлид/архитектор.
Main `6733f9703a2588dd2978bdd5059fc763f943bb28` /2.6.1.
Проверка документации, публичных интерфейсов/конфигурации, diff, готового CI и
артефакта; построчный аудит реализации и повторный полный тестовый прогон не выполнялись.

## Принятые результаты

**Backend PR30**, source `e838d11e61b7f5a996ab9eb0095a3a0929660488`,
tree `84117e56f1b861325ffc99ca405dc9ee7bbe4b71`.
Изменены11 файлов в согласованной области: HTTP docs, внутренний контракт/ТЗ/
отчёт, Origin helper/Cloudflare gate, минимальный API guard и адресные тесты.
SQL, wire JSON, версии, Android, модель и начисления не изменены.
[CI40877269886](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40877269886)
**SUCCESS**, в том числе browser, build и backend dry-run;
логи: **408 PASS /1 SKIP /0 FAIL**. Android SKIPPED.
В логах подтверждены реальные handler/SQLite тесты profile, request-bound proof,
отказы direct/Sites/Node, preflight без D1, auth/ownership и идемпотентность.
Заявленные15 адресных тестов входят в эти проверки. Это CI evidence,
а не новый запуск Тимлидом. Реализация пригодна для подготовки выпуска;
опубликованный Worker пока прежний — **NOT_DEPLOYED**.

**Frontend PR31**, source `39b2048f513ed71653a6c9728b33311dba131c35`,
tree `6c00be571e504b4ea0f6ec9f13ec6892434f6286`, dirty=false, app2.6.3.
Приращение от PR29 8d66479 —17 файлов в границах full static build/context,
минимальных platform/bootstrap/diagnostics hooks, publisher/workflow и тестов.
Views/services/registry/runtime/алгоритмы переиспользованы, API/D1/Android не менялись.
[CI40878903047](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40878903047)
**SUCCESS**, включая browser/build/dry-run; **446 PASS /1 SKIP /0 FAIL**,
Android SKIPPED.
[Preview CI40878903250](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40878903250)
**SUCCESS**: unit/format/build, local SQLite browser, static publication и
внешний read-only browser. 11 адресных unit заявлены и шаг успешен.
Это полная оболочка приложения, а не прежний отдельный workout harness.

## Публикация и реально полученный артефакт

Проверенный по CI стабильный alias:
https://preview-67f2889c80972c44.movement-preview.pages.dev.
Deployment ID `80617e69-54ad-4913-9f73-136a0aa1d82b`;
immutable https://80617e69.movement-preview.pages.dev.
Schema1, previewVersion `preview-39b2048f513ed71653a6c9728b33311dba131c35`,
real/real/camera, единственный API
https://movement-test-api-staging.rojoscarlos93.workers.dev/api.
Manifest/HTML/browser evidence относятся к одному full source/tree, dirty=false.

[Artifact12899272272](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40878903250/artifacts/12899272272)
реально скачан и проверен: **15 475 567 bytes**,
SHA256 **b98e60da403f4a35e5badf928376dd4a18a8d2c38d74b0e2ca08d870f82a40ca**,
совпадает с GitHub digest. Срок до2027-01-27T13:06:19Z.
Нет APK/ключей/Functions/server output; Full имеет прежний SHA256, оба WASM на месте.
Пять снимков393×852/852×393 проверены по размерам; полная оболочка/auth и
Диагностика визуально просмотрены. На опубликованных снимках ожидаемая
ошибка подключения до выпуска API; это не доказательство рабочего live-профиля.
Локальный fixture покрывает навигацию/guest/profile/program/pause/abort/reload/
offline/lost-ACK/retry с одной временной SQLite; fake camera указан явно.
Внешний smoke не создавал профили/результаты; evidence не содержит POST.

Три SUCCESS publish runs одной ветки:
[70f08b0/40878169408](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40878169408),
[8391b89/40878447343](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40878447343),
[39b2048/40878903250](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40878903250).
Source/статусы сверены; alias детерминирован из полного branchRef и совпадает
с latest artifact. **VERIFIED_AUTO** принимается для этой ветки.
Root proxy-среда не использовалась как доказательство доступности: внешний
HTTP/browser подтверждён готовым CI, а не повторным просмотром Тимлида.

## Совместимость и текущий блокер

HTTP-контракт одинаков: контролируемый Origin, Authorization/Content-Type,
OPTIONS204, читаемый401 DEVICE_AUTH_REQUIRED без cookies, прежние wire/UUID/ACK.
Публичные функции Origin helper соответствуют внутреннему контракту;
ApiErrorBody.code:string уже допускает новый INVALID_PREFLIGHT.
Отдельного изменения типов/валидаторов JSON не требуется.
Frontend requirements/source не меняются для внутреннего proof Backend.

Архитектурных блокеров в заявленных границах не обнаружено.
Это архитектурная приёмка по перечисленным источникам, не независимый security
аудит и не физическая проверка камеры.
**Live-приложение остаётся API_DEPLOY_PENDING**:
browser-published.json сообщает непрозрачный ответ health/preflight/anonymous
state. Главный следующий результат — активация принятого Worker и только
read-only проверка CORS/GET→401 из реального alias.
До этого живой вход/сохранение не объявлять готовыми.
Известный pushup initial-pose дефект и Android/FPS/разрешения не закрыты.

## Конкретное ограничение текущего выпуска

[deploy.yml](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/e838d11e61b7f5a996ab9eb0095a3a0929660488/.github/workflows/deploy.yml)
обязательно выполняет `android` и затем `npm run backend:deploy` в шаге
«Migrate, deploy and verify». Это полный выпуск с APK и remote migration path,
а не согласованный API-only этап.
Не запускать его как будто он сохраняет APK/не выполняет SQL.
Новые миграции в PR30 отсутствуют, но вызов apply не равен отсутствию remote-операции.

Следующий узкий пакет:
[MOV-WEB-RELEASE-01](../tasks/MOV-WEB-RELEASE-01.md) — подготовить управляемую
публикацию только Worker с сохранением существующих assets/ASSETS binding,
APK, D1, secrets/vars, cron и прочих настроек.
Cloudflare API документирует `keep_assets:true`:
[Upload Worker Module](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/).
Документация проверена; способность нового инструмента сохранить конкретный
Worker ещё должна быть проверена исполнителем, не заявляется готовой.

Нужны готовые инструмент/manifest/dry-run и точный Source SHA перед последним
owner approval. Подготовка этого пакета разрешена; фактическая публикация,
main merge и любые remote записи ещё не разрешены.
После неё — owner-команда на выпуск, затем CORS read-only smoke и
реальные действия владельца в браузере. Новый APK на этом этапе не нужен.
