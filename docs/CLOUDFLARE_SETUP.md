# Единственный Cloudflare backend

Основной репозиторий — APP-updated-version-, ветка main, версия 2.5.4.

Адрес: **https://movement-test-api-staging.rojoscarlos93.workers.dev**.
Worker: `movement-test-api-staging`; D1: `movement-test-app-staging`.
Это единственный основной сервер. Техническое имя сохранено ради существующих профилей и локальных очередей. История объединения и архива старой базы: [SINGLE_SERVER.md](SINGLE_SERVER.md).

## Секреты

В [Actions secrets основного репозитория](https://github.com/rojoscarlos-cpu/APP-updated-version-/settings/secrets/actions) должны находиться:

- `CLOUDFLARE_API_TOKEN`: Account / Workers Scripts / Edit, D1 / Edit, Account Settings / Read; область — нужный аккаунт.
- `CLOUDFLARE_ACCOUNT_ID`: идентификатор аккаунта с workers.dev-поддоменом rojoscarlos93.
- `STAGING_ANDROID_KEYSTORE_BASE64`: прежний ключ Android. Название секрета техническое; второй канал публикации оно не создаёт.

Значения не входят в исходники, APK или журналы. GitHub не выдаёт значения существующих secrets для чтения. Восстановление ключа: [ANDROID_SIGNING.md](ANDROID_SIGNING.md).

## Выпуск

Обычный push и PR выполняют проверки; push main также собирает APK. Для отдельной публикации по прямой команде владельца:

1. Actions → Movement — manual deployment → Run workflow.
2. Выбрать main.
3. В поле confirmation ввести `deploy` и запустить.
4. Дождаться проверок, APK из того же коммита, миграций существующей D1, deploy и полного сравнения SHA-256 публичного скачивания.

Других целей нет. Workflow разрешает деплой только из main, с единственным Worker/D1 и точным hostname. Отсутствующая основная база считается ошибкой — создание пустой замены запрещено.

Прямой запуск из подготовленной среды с настроенными секретами:

```sh
npm run backend:deploy
```

BACKEND_TARGET больше не поддерживается. Прежние команды с production/staging останавливаются до публикации. Применённые SQL-миграции не переписывать; изменения добавляются отдельными файлами.

## Проверка без публикации

```sh
npm ci
npm test
npm run build
npm run backend:validate
```

Последняя команда — dry-run. Локальный Node использует отдельную SQLite. До явного гостевого входа `/api/state` возвращает `401 DEVICE_AUTH_REQUIRED`; это нормальное требование авторизации.

Проверка выпуска подтверждает версию/JSON, отказ без сессии, гостевой вход, чтение D1 через API v1/v2 и отзыв тестовой сессии без добавления фиктивных профилей. Публичный APK проверяется по размеру, метаданным и полному SHA-256.
