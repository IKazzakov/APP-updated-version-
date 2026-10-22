# Публикация сервера Движение

Ветка: `codex/backend-hosting-2.5.1`, новая версия клиента/API: **2.5.2**.
Принятая 2.5.1 остаётся в `codex/build-android-apk` и коммите `5107454`.

Опубликованный сервер: https://movement-test-api.rojoscarlos93.workers.dev

Адрес API для APK: https://movement-test-api.rojoscarlos93.workers.dev/api

## Разовое подключение

1. В Cloudflare откройте Workers & Pages. Если аккаунт новый, выберите
   поддомен `workers.dev`. Покупать или переносить домен не требуется.
2. https://dash.cloudflare.com/profile/api-tokens → Create Token →
   Create Custom Token. Название: `movement-github-deploy`.
3. Permissions: Account / Workers Scripts / Edit; Account / D1 / Edit;
   Account / Account Settings / Read. Account Resources: Include /
   Specific account / ваш аккаунт.
4. Continue to summary → Create Token. Сохраните значение в GitHub:
   https://github.com/rojoscarlos-cpu/Test/settings/secrets/actions →
   New repository secret → имя `CLOUDFLARE_API_TOKEN`.
5. В Cloudflare → Workers & Pages → Account Details скопируйте Account ID.
   Добавьте второй GitHub repository secret: `CLOUDFLARE_ACCOUNT_ID`.

Значения секретов не добавляйте в исходники, APK или переписку.

## Публикация

Workflow `Backend — checks and deployment` запускается при push в ветку
`codex/backend-hosting-2.5.1`. На PR выполняются только проверки.
Публикация из других веток отключена, чтобы не перезаписать рабочий сервер.

Сценарий проверяет тесты и сборку, находит или создаёт D1 `movement-test-app`,
применяет миграции и публикует `movement-test-api`. База выбирается по точному
имени; существующая база не заменяется. Повторный запуск сохраняет данные.
Новые SQL-миграции добавляйте отдельными файлами, старые не меняйте.

Адрес опубликованного API появится в Summary запуска и артефакте
`backend-deployment` → `deployment.json`. Результат создаётся только после
проверки JSON, версии, анонимного отказа, гостевой сессии, чтения D1 и выхода.
Проверка не добавляет фиктивных профилей или приседаний в рейтинги.

Если секреты добавлены после неудачного запуска, откройте запуск в GitHub
Actions и выберите Re-run failed jobs. Когда workflow появится в `main`,
можно также запускать его вручную через Run workflow, выбрав эту ветку.

## APK и авторизация

Для нового API нужен клиент **2.5.2**: 2.5.1 передаёт тестовое имя вместо
индивидуальной сессии и не сможет войти. После публикации APK собирается
с `VITE_API_BASE_URL=<адрес>/api`; существующий клиент 2.5.2 позволяет также
изменить адрес через «Подключение к серверу».
Сохранённые адреса старых предпросмотров `ais-pre` / `ais-dev` этого проекта
при первом запуске 2.5.2 заменяются новым адресом; другие настройки сохраняются.

Гостевой профиль привязан к устройству и серверу. Имя — отображаемая подпись,
не пароль. Одинаковые имена не объединяют аккаунты. На устройстве хранится
случайный индивидуальный ключ, в D1 — его SHA-256. Выход отзывает сессию.
Нельзя выйти при неподтверждённых повторениях: сначала дождитесь синхронизации.
После выхода, удаления приложения или очистки данных новый гостевой старт
создаёт другой профиль. Перенос аккаунта на другой телефон требует отдельной
функции восстановления / входа и в этот этап не входит.

Публичный Worker не доверяет `x-test-user-id` или заголовкам идентичности Sites.
Регистрация ограничена по частоте; у каждого пользователя собственный токен.
Административного ключа Cloudflare в приложении нет.

Исходный приватный Sites и его D1 не меняются. Новый сервер использует отдельную
базу: данные старого размещения автоматически не переносятся.

## Локальная проверка

```sh
npm ci
npm test
npm run build
npm run backend:validate
```

`backend:validate` компилирует настоящий Worker и проверяет конфигурацию,
не публикуя его. Для Node-предпросмотра: `npm run dev`. Он использует такую же
авторизацию с локальной SQLite. Для исходного Sites-предпросмотра:
`npm run dev:sites`.

Для ручного деплоя с настроенными переменными окружения: `npm run backend:deploy`.
Нужен Node.js 24+, TLS и штатный прокси сохраняются. В среде Codex сетевой доступ
к Cloudflare не настроен, поэтому публикацию выполняет GitHub Actions.

## Если публикация не прошла

- Ошибка missing secrets: проверьте точные имена двух repository secrets.
- Cloudflare 403: проверьте права токена и его Account Resources.
- Ошибка workers.dev: закончите настройку поддомена в Workers & Pages.
- Ошибка миграции: изучите сообщение; успешные предыдущие миграции сохраняются.
- HTML вместо API: проверьте адрес, run_worker_first и выбранную версию сервера.
- Рабочий адрес и логи: Cloudflare → Workers & Pages → movement-test-api.

Документация: [Cloudflare tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
[Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/),
[GitHub secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
