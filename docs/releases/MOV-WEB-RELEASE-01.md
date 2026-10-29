# MOV-WEB-RELEASE-01 — подготовка выпуска Worker

Статус: **PREPARED / NOT_DEPLOYED**. Цель — опубликовать только принятый код
MOV-WEB-API-01 после отдельной команды владельца. Исходная ветка задания —
`codex/mov-web-release-01-20261029` от `82bef76a86f79033448b26457c2adfe67bb13135`.
Принятый API: `e838d11e61b7f5a996ab9eb0095a3a0929660488`, tree
`84117e56f1b861325ffc99ca405dc9ee7bbe4b71`. Исходная main:
`6733f9703a2588dd2978bdd5059fc763f943bb28`. Версия 2.6.1.

## Состав и граница

`scripts/release-web-api.mjs` имеет режимы `prepare` (по умолчанию), `deploy`,
`verify`. Подготовка создаёт `work/web-api-release/manifest.json` и точный bundle
`bundle/cloudflare.js` через Wrangler dry-run. Manifest содержит полный source SHA,
tree, dirty, версию, SHA-256 и размер bundle. При доступных Cloudflare credentials
подготовка только читает control plane: поддомен, список D1, deployments, активную
версию и script-settings; также сверяет опубликованные HTML и APK, их metadata и
контрольную сумму. Вариант без credentials пишет `NOT_RUN` для remote inspection.

`deploy` допускается только из чистого `main` при `workflow_dispatch`, полном
`expected_source_sha`, равном checkout SHA, и `confirmation=deploy-web-api`.
Повторно проверяются источник, bundle, действующая Worker version, bindings,
каноническая D1 и опубликованные assets/APK. Загрузка идёт через Cloudflare
Workers Versions API с `keep_assets:true`, `bindings_inherit=strict` и наследованием
всех имён bindings. Новых asset JWT/manifest, asset upload session, SQL, APK build,
guest/profile и иных записей в API нет. Новая версия активируется отдельным
deployment на 100%. Общий Actions lock — `movement-deploy`.

Текущие Worker `movement-test-api-staging`, D1 `movement-test-app-staging`,
`AUTH_LIMITER`, `ASSETS`, workers.dev и API URL закреплены. При расхождении
поддомена, DB ID, binding, runtime metadata, активной версии или ответов API
загрузка останавливается. Значения secrets и raw settings в manifest не пишутся.
Cron, routes и script-settings не изменяются вызовом выпуска.

## Порядок владельца после review

1. Получить review PR и отдельно разрешить merge в `main`. Проверить новый
   полный SHA `main`; прежняя команда на другой SHA не подходит.
2. Запустить Actions → **Movement — Worker-only release** → `main`, `mode=prepare`.
   Скачать приватный artifact `web-api-prepared-<SHA>` и проверить manifest,
   `remote.status=PASS`, source/tree/dirty=false и SHA-256 bundle.
3. После отдельной прямой команды владельца запустить тот же workflow из `main`
   с `mode=deploy`, `expected_source_sha=<полный SHA>` и
   `confirmation=deploy-web-api`. Этот запуск сначала повторяет prepare.
4. Дождаться `VERIFIED`: активная версия, bindings, HTML/APK checksum, health,
   OPTIONS и анонимный JSON 401. Browser проверка из опубликованного full-app
   alias делает только GET, с browser preflight и без Bearer/cookies.

Если ответ Cloudflare потерян после upload/activation, статус **VERIFY_REQUIRED**.
Проверить фактический active deployment/version и опубликованный API до любого
повторного запуска. Предыдущий Worker version ID сохраняется в приватном
manifest/deployment artifact. План отката — новый percentage deployment на 100%
предыдущей версии; SQL, assets и APK не откатываются. Откат не автоматический.

`verify` не выполнялся против live API: до команды владельца новый Worker не
опубликован. Опубликованный Frontend до этого сохраняет `API_DEPLOY_PENDING`.

## MOV-WEB-RELEASE-01-NET — диагностика отказа prepare

Проверены main `50bab63c34ad95e795f9508a33307b93af0c9eb3` и исходный коммит
задания `3cee53eacf543c732fc6fa15bfb1f465ac90562a`, версия 2.6.1.
Прочитан лог job `123518390398` ручного
[prepare 40893762949](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40893762949).
Установлен дефект наблюдаемости: исходный GET transport exception доходил до
CLI как `fetch failed`, без этапа и `cause.code`; upload artifact после отказа
пропускался. **Сетевой этап и причина прежнего отказа не установлены**:
исторический лог этих данных не содержит. Неверный token, отсутствие Worker,
ошибка D1 или внешняя network policy не доказаны. Локальные ограничения sandbox
не являются объяснением ошибки отдельного GitHub runner.

Теперь каждый GET control plane имеет закрытую метку `CF_SUBDOMAIN`,
`CF_DATABASES`, `CF_DEPLOYMENTS`, `CF_VERSION`, `CF_SETTINGS`; опубликованные
файлы — `PUBLIC_HTML`, `PUBLIC_APK_METADATA`, `PUBLIC_APK_CHECKSUM`, `PUBLIC_APK`.
Ошибка запроса или чтения тела содержит только этап, тип из закрытого списка,
известный сетевой `causeCode` при наличии и фактически полученный HTTP status.
HTTP 403 фиксируется до чтения тела; у исключения до response HTTP status
отсутствует. Неизвестные имена/коды отбрасываются; URL/hostname, IDs, headers,
raw message/stack, response body и settings/vars в диагностике отсутствуют.
POST upload/activation и прежние release guards сохранены, retries не добавлены.

При отказе `prepare` пишет `work/web-api-release/error.json` с `status=FAILED`,
режимом файла 0600. Ошибка вне GET получает общий этап `PREPARE`; это не
утверждение о сетевой причине. Перед подготовкой удаляются прежние manifest
и error JSON. Ошибка не превращается в PREPARED; CLI завершает работу с кодом 1.
Workflow на failure сохраняет только этот безопасный JSON в приватный artifact
`web-api-prepare-error-<SHA>` на 14 дней. Отсутствующий JSON проваливает upload.
Успешный manifest/bundle по-прежнему сохраняется отдельным прежним шагом;
режимы, secrets, условия deploy и main/SHA/confirmation guards не расширены.

Проверки этой правки:

- `node tests/web-api-release.test.js` — PASS, включая холодный запуск без
  `dist/client`, прежние отрицательные guards и 63 fixtures: все 9 этапов ×
  DNS/TLS/connect timeout/reset/HTTP 403/body failure/неизвестная ошибка.
  Дополнительно invalid JSON сохраняет stage/status; marker-secret из
  URL/message/cause/headers отсутствует в error message/stack/JSON и artifact.
  Проверены отсутствие retries, удаление старого manifest и очистка error
  после успешного prepare на fake transport с настоящей проверкой APK checksum.
- `node --check scripts/release-web-api.mjs`, `npm run typecheck`, `npm run lint`,
  адресный `prettier --check` трёх изменённых code/YAML-файлов,
  YAML parse, failure artifact/deploy dependency и `git diff --check` — PASS.
- Реальный локальный `prepare` проверяется через штатный Wrangler `deploy
  --dry-run` без Cloudflare credentials; remote inspection остаётся `NOT_RUN`.
  Это не результат fake transport и не remote.status=PASS.
- Обязательный CI запускается штатным PR; полный ручной набор, APK, remote
  prepare, deploy, verify, live guest/profile/SQL — NOT_RUN в этом пакете.

Передача Тимлиду: сначала review этого PR и отдельная команда владельца на
merge в main. Затем разрешённый read-only `mode=prepare` на новом main SHA.
При отказе получить `web-api-prepare-error-<SHA>/error.json`; при успехе проверить
настоящий manifest и remote.status. Только эти данные позволят установить
точный сетевой этап/код и выбрать минимальное подтверждённое исправление.
Если причина внешняя, нужны изменения сети/прав или другие файлы — согласовать
точное требование отдельной задачей; не менять Origin/policy/TLS/proxy по догадке.
Слияние и deploy этим пакетом не разрешены; Worker/D1/статика/APK не изменены.


## Проверка Тимлида — remote prepare 40904842514

PR34 слит по прямому разрешению владельца. Main/source
`952da1e0e4753309e7fcfe51f42fefbb66a1b010`, tree `b308d9301b84bd087fc6435065f38a79040d1053`, версия2.6.1.
Дерево совпадает с принятым b38d585; Worker не опубликован.

[Run40904842514](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40904842514), attempt1,
завершился FAILURE: build и release unit PASS; prepare job123556675127
остановился с `PUBLIC_HTML / TypeError`. HTTP status и causeCode отсутствуют.
Error artifact12911366141 скачан; ZIP 233 bytes, SHA256
`377675ecc90520e7d34bca615c365c46576d277d2b918cad9ac9eb923f8cd154`
совпадает с GitHub digest. Внутри только error.json:

```json
{"schema":1,"status":"FAILED","diagnostic":{"stage":"PUBLIC_HTML","errorType":"TypeError"}}
```

Установлен этап чтения опубликованной страницы, корневая причина UNKNOWN.
Ни Cloudflare auth failure, ни CORS, ни отсутствие D1 этим не доказаны;
PASS остальных remote этапов также не заявляется. Manifest успеха отсутствует,
remote readiness не подтверждён. Deploy job123557078913 SKIPPED.
Worker/D1/assets/APK не изменены, повторов этого run Тимлидом нет.

Следующий узкий пакет [MOV-WEB-RELEASE-02](../tasks/MOV-WEB-RELEASE-02.md):
воспроизведение/исправление PUBLIC_HTML через безопасный публичный GET
из PR runner без credentials до нового main merge. Frontend и алгоритмы
не затрагиваются. После приёмки — отдельно разрешённое слияние/remote prepare;
публикация требует собственной команды владельца.

## MOV-WEB-RELEASE-02 — причина PUBLIC_HTML и проверка исправления

Проверены base/main `952da1e0e4753309e7fcfe51f42fefbb66a1b010`, tree
`b308d9301b84bd087fc6435065f38a79040d1053`, версия 2.6.1 и исходный коммит
постановки `97f09ce0f78abe2718a5e2094bc3af60584b4966`. Исходный коммит
сохранён в [draft PR35](https://github.com/rojoscarlos-cpu/APP-updated-version-/pull/35).

На GitHub PR runner с Node 24 и `--use-env-proxy` выполнено сравнение без
credentials и без автоматического перехода на другой host. В
[run 40908295977, job public-read](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40908295977/job/123568988965)
на source `4b292abcd1848197ecbb71df458a83da65481ca3`:

- исходный GET `/index.html` с фактическими release options, включая
  `redirect: 'error'`, завершился `REQUEST / TypeError / UNKNOWN` без HTTP status;
- тот же адрес с `redirect: 'manual'` вернул HTTP 307; проверена только
  безопасная булева характеристика, что цель — корневая страница этого origin;
- GET `/` с прежними release options и отдельный минимальный GET `/` оба
  получили HTTP 200 и прочитали тело. Диагностический job намеренно завершился
  с ненулевым кодом, поскольку исходный release GET не прошёл.

Таким образом, отказ воспроизводится из-за канонического redirect
опубликованного `/index.html`: Node fetch при `redirect: 'error'` отклоняет
его как `TypeError`. Причина не связана с предположениями о токене, CORS или D1.
Теперь PUBLIC_HTML читает сразу `/`; прочие публичные файлы, проверки их
checksum и guard-условия выпуска сохранены. Redirect по-прежнему запрещён.

В [run 40908941783, job public-read](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40908941783/job/123571294704)
на исправленном source `a023401ff97e43d4ceb305e60b3b7b456529e302` реальный GET
через ту же функцию, что используется в release, и отдельный минимальный GET
получили HTTP 200 и прочитали тело; оба результата PASS. Проверка фиксирует
получение ответа, 2xx и чтение тела раздельно; она не заявляет проверку
содержимого всего выпуска и не вызывает prepare или Cloudflare control plane.

Диагностика различает создание запроса, transport, HTTP response и чтение тела;
сохраняются только закрытые имена типов, известные коды либо `UNKNOWN`,
фактически полученный status и фиксированная категория `REDIRECT_REJECTED`
для установленного отказа Node. Обход вложенных `cause`/`AggregateError.errors`
ограничен глубиной, числом элементов и посещений, с защитой от циклов; raw
сообщения, URL, headers, body, account/database IDs и настройки не выводятся.

В том же исправленном PR run холодный `node tests/web-api-release.test.js` без
`dist/client` прошёл: прежние release guards и 63 staged fixtures, локальный
307 redirect с реальным Node fetch, безопасные фазы и ограниченная обработка
циклов/вложенных причин с marker-secret. Синтаксис, адресный Prettier и YAML
проверены локально. Полный remote prepare, remote.status=PASS, deploy, миграции,
APK и физическая приёмка телефона в этой задаче не выполнялись и не доказаны.
После review и отдельного разрешения на merge Тимлид запускает read-only
remote prepare; публикация Worker требует отдельной команды владельца.
