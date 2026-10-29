# MOV-WEB-RELEASE-01 — подготовка выпуска только принятого API

## Роль, один результат и база

Ты — Backend/инфраструктура «Движения», новый отдельный тред.
Одна цель: подготовить исполняемый release-путь только Worker MOV-WEB-API-01
без сборки/публикации APK, SQL-миграций, тестовых записей и изменения существующей статики.
**Сейчас разрешена подготовка, а не remote публикация.**

- Repo https://github.com/rojoscarlos-cpu/APP-updated-version-.
- Base PR30 `e838d11e61b7f5a996ab9eb0095a3a0929660488`, tree
  `84117e56f1b861325ffc99ca405dc9ee7bbe4b71`, /2.6.1; CI SUCCESS.
- Ветка `codex/mov-web-release-01-20261029`; PR target
  `codex/mov-web-api-01-20261029` (stacked PR к PR30).
- Main `6733f9703a2588dd2978bdd5059fc763f943bb28`; проверить refs/SHA/status/
  версии до работы; сохранить начальный коммит постановки и чужие изменения.
- Frontend source `39b2048f513ed71653a6c9728b33311dba131c35` /2.6.3, API не требует пересборки этого клиента.
  [Заключение Тимлида](../reviews/MOV-WEB-01.md) — доказательства и ограничение deploy.yml.
- Внутренние подагенты и повторное делегирование не разрешены.

## Инструкции и чтение

Обязательные pinned инструкции PR24:
[AGENTS](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/AGENTS.md),
[TEAM_CONTEXT](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/TEAM_CONTEXT.md),
[Backend](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/team/BACKEND.md),
[DEVELOPMENT](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/DEVELOPMENT.md).
В этой ветке прочитать API.md, SINGLE_SERVER.md, CLOUDFLARE_SETUP.md,
WEB_APP_CONTRACT.md, API_ORIGIN_ADAPTER_CONTRACT.md;
wrangler.backend.json, scripts/deploy-backend.mjs, release-checkpoint.mjs,
validate-backend.mjs, .github/workflows/deploy.yml и checks.yml.
Использовать нужные разделы/прямые зависимости, не обходить весь клиент.
[Frontend отчёт](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/39b2048f513ed71653a6c9728b33311dba131c35/docs/releases/MOV-WEB-APP-01.md).

## Контракт инструмента и границы эффектов

Новый scripts/release-web-api.mjs: явные prepare/deploy/verify режимы.
prepare по умолчанию: сборка Worker/manifest/контрольные суммы, проверка плана
и при доступе только GET настроек действующего Worker; **ноль remote mutations**.
Не вызывать существующий deploy main()/smokeBackend целиком и не импортировать
модули с незащищёнными побочными эффектами.
deploy требует одновременно ручной workflow_dispatch из main, точный полный
expected_source_sha=checkout SHA и confirmation=deploy-web-api.
Push/PR/prepare/невалидный input никогда не публикуют. Прямая команда владельца
на выполнение deploy должна быть получена отдельно после готовности кода.

Единственные цели зафиксированы:
Worker movement-test-api-staging, существующая D1 movement-test-app-staging,
API https://movement-test-api-staging.rojoscarlos93.workers.dev/api.
Ни нового Worker/БД/namespace, ни смены API, ни авторегистрации ресурсов.
Артефакт содержит source/tree/dirty/version, Worker bundle SHA256, план сохранения
настроек, прежнюю версию для отката и sanitised evidence. Секреты/их значения/
raw settings с приватными vars в логах и артефакте не сохранять.

Публикуется только код Worker. Для сохранения статики использовать подтверждённую
семантику официального Cloudflare API `keep_assets:true`
([API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[документация](https://developers.cloudflare.com/workers/static-assets/direct-upload/)).
Не передавать новый asset completion JWT/manifest и не открывать assets-upload-session.
Сохранить routing config/ASSETS binding по фактическому API-контракту,
существующие DB/ratelimit/другие bindings, vars/secrets, cron/route настройки.
Сверить каноническую DB с текущим binding; при несовпадении/неясности остановиться.
Не снимать защиту/Origin/Bearer и не менять код приложения ради release.

Нет d1 migrations apply/execute, guest/profile/repetitions/finish/abort и тестовых
профилей в live API. Подготовка без credentials честно отмечает NOT_RUN remote GET;
не просить токены в чат, не подменять injected credentials.
В CI используются существующие защищённые Cloudflare bindings только в нужных шагах.
Операции деплоя сериализуются общим lock movement-deploy, не отменять текущий выпуск.
При потерянном ответе сначала проверить фактическую активную версию/digest,
а не слепо повторять публикацию. Откат — предыдущая Worker version, без SQL/assets.

verify после отдельно разрешённого deploy:
health, OPTIONS с Origin фактического full-app alias и anonymous GET→401/JSON,
без Bearer/cookies. Browser проверка только read-only на source Frontend:
https://preview-67f2889c80972c44.movement-preview.pages.dev.
API_DEPLOY_PENDING/CORS opaque ответ обязан провалить приёмку; прежний permissive
preview PASS с pending не является успешной postflight проверкой.
Сверить сохранность asset binding и опубликованных APK metadata/checksum до/после;
не собирать новый APK. Не утверждать, что этот live этап выполнен до owner-команды.

## Файлы и владелец

Один Backend владеет только:
- новым scripts/release-web-api.mjs;
- новым .github/workflows/release-web-api.yml;
- новым tests/web-api-release.test.js;
- новым docs/releases/MOV-WEB-RELEASE-01.md;
- package.json — при необходимости только отдельная команда, без version/deps.

Существующие workflows/deploy scripts, server, SQL, wire, Android, algorithms,
public assets и Frontend branch read-only. Если безопасное сохранение настроек
требует иного файла — вернуть точный минимальный diff Тимлиду.
Не переписывать CI/release систему целиком и не добавлять новый API.

## Приёмка и проверки

1. Unit инструмента с fake Cloudflare transport: prepare не делает remote write;
   неверный Worker/DB/source/main/confirmation/dirty/metadata блокируют upload;
   expected bundle hash/keep_assets/settings preservation проверены.
   Негативы для нового asset upload, SQL/auth writes и невалидного response.
2. Lost-response/verify_REQUIRED и безопасный rollback plan, без удаления данных.
3. Syntax/format/diff и Worker dry-run ровно на итоговом source, manifest/digest
   доступны в приватном GitHub artifact. Новый workflow проверен как YAML;
   mandatory CI сохраняется, полный ручной набор/APK не повторяются.
4. Секреты/закрытые данные отсутствуют в output/evidence. В prepare допускается
   read-only Cloudflare inspection из Actions; actual deploy не запускать.
5. Вернуть PR/head/source/tree, artifact/SHA256, фактические проверки/NOT_RUN,
   точный порядок owner-запуска и пределы rollback. Статус PREPARED,
   а не DEPLOYED. После review Тимлид запросит последнюю owner-команду.

Серверный бизнес-код уже принят к подготовке выпуска. Этот пакет не повторяет
реализацию CORS и не требует новых правок Frontend.
