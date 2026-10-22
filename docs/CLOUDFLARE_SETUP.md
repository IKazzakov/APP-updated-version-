# Cloudflare и ручная публикация

Основной репозиторий — `rojoscarlos-cpu/APP-updated-version-`, основная ветка — `main`, версия исходников — 2.5.3. Новый репозиторий использует существующие серверы; отдельная инфраструктура автоматически не создавалась.

| Цель | Worker / D1 | Адрес |
| --- | --- | --- |
| production | `movement-test-api` / `movement-test-app` | https://movement-test-api.rojoscarlos93.workers.dev |
| staging | `movement-test-api-staging` / `movement-test-app-staging` | https://movement-test-api-staging.rojoscarlos93.workers.dev |

Текущий Android-пакет `com.movement.squat.staging.ui` использует staging API. Выбор production для публикации сервера не переключает установленный APK на другой API и не переносит профили. Такой переход согласовывается отдельно.

## Подключить новый репозиторий

1. В Cloudflare убедиться, что выбран нужный аккаунт и настроен поддомен workers.dev.
2. Создать или взять из защищённого хранилища владельца API token: Account / Workers Scripts / Edit, D1 / Edit, Account Settings / Read; область — нужный аккаунт. [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens).
3. В [APP-updated-version- → Actions secrets](https://github.com/rojoscarlos-cpu/APP-updated-version-/settings/secrets/actions) добавить `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`.
4. Для APK добавить прежний `STAGING_ANDROID_KEYSTORE_BASE64` по [инструкции подписи](ANDROID_SIGNING.md).

Секреты не переносятся при копировании репозитория. Значение существующего GitHub secret прочитать обратно нельзя; имя секрета или старый успешный запуск не доказывают готовность нового репозитория. Токены не добавлять в исходники, APK, журналы или переписку.

## Публикация через Actions

Обычные push, PR и слияние в main выполняют проверки; рабочий deploy автоматически не запускается.

После прямого решения владельца о публикации:

1. Открыть Actions → **Movement — manual deployment** → **Run workflow**.
2. Выбрать ветку проверенного кода. Для production разрешена только `main`.
3. Выбрать `target=staging` или `target=production`.
4. Ввести соответственно `deploy staging` либо `deploy production`, затем запустить.
5. Дождаться проверок, сборки APK из того же коммита, миграций, Worker deploy, API smoke и проверки полного SHA-256 скачанного APK.

Ручной workflow появляется в интерфейсе после его согласованного слияния в main. До этого адаптация CI проверяется в отдельной ветке и PR без публикации.

Результат — artifact `backend-<target>-<commit>` с `deployment.json`. Workflow использует APK текущего коммита, не создаёт коммитов в ветках и не выполняет слияние. Прежний APK или прежние метаданные при задержке Cloudflare не принимаются за успешную публикацию.

Скрипт `scripts/deploy-backend.mjs` выбирает D1 по точному имени, создаёт её только при отсутствии, применяет добавочные миграции и публикует Worker. Production и staging имеют разные имена ресурсов. Самостоятельный прямой запуск требует явно выбрать целевой сервер:

```sh
BACKEND_TARGET=staging npm run backend:deploy
```

`BACKEND_TARGET=production` используется только по отдельной прямой команде владельца. Ранее применённые миграции не переписывать; база и гостевые сессии сохраняются. Рабочую базу не использовать для нагрузочных тестов.

## Проверка без публикации

```sh
npm ci
npm test
npm run build
npm run backend:validate
```

Последняя команда выполняет только dry-run. Node-предпросмотр (`npm run dev`) использует отдельную локальную SQLite. API на публичном Worker использует индивидуальную Bearer-сессию устройства и не доверяет заголовкам идентичности Sites или тестовым заголовкам.

До гостевого входа `GET /api/state` возвращает `401 DEVICE_AUTH_REQUIRED`. Это нормальное требование авторизации. При HTML вместо JSON проверить адрес и `run_worker_first`; при Cloudflare 403 — аккаунт и права токена; при missing secrets — точные имена и настройки именно нового репозитория.
