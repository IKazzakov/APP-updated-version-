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
