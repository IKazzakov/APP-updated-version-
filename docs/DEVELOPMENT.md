# Разработка · одна основная ветка и сервер

Основной проект — `rojoscarlos-cpu/APP-updated-version-`, ветка `main`, версия **2.5.4**. В main объединены архитектура, подготовка CI/Android и история выпуска. Временные ветки после слияния удаляются; отдельной постоянной тестовой ветки нет.

## Сервер

Единственный основной адрес — `https://movement-test-api-staging.rojoscarlos93.workers.dev`.
Worker `movement-test-api-staging`, D1 `movement-test-app-staging`. Суффикс в именах технический. [Выбор основной базы, перенос профиля и архив](SINGLE_SERVER.md).

Применённые миграции не изменять. Деплой не создаёт замену существующей базе и не поддерживает выбор другой цели. Камера, алгоритм squat-v1, полная минута и правила начислений не меняются при объединении инфраструктуры.

## Локальная работа

Нужны Node.js 24+ и npm:

```sh
npm ci
npm run typecheck
npm run format:check
npm run lint
npm test
npm run build
npm run backend:validate
```

Для браузерных сценариев:

```sh
npm install --prefix work/browser-tools --no-save playwright-core@1.58.2
NODE_PATH="$PWD/work/browser-tools/node_modules" CHROMIUM_PATH=/usr/bin/chromium npm run test:browser:all
```

Нужны Chromium/Chrome и локальные порты. Тесты используют отдельные SQLite, профили и искусственную камеру. Реальные движения и производительность S23 проверяются отдельно. Исторические числа тестов в отчётах относятся к своим версиям; актуальный итог фиксируется в CI текущего коммита.

## Android

Полный JDK 21 с javac, SDK 36, Build Tools 36.0.0 и platform-tools. Wrapper использует Gradle 8.14.3. Подготовленные локальные инструменты находятся в игнорируемом work/android-env:

```sh
source scripts/android-env.sh
npm run build:apk
```

Скрипт сохраняет явно заданные JAVA_HOME/ANDROID_HOME; по умолчанию использует work/android-env/jdk и sdk. Игнорируемый local.env содержит настройки штатного прокси/CA текущей среды. Кэши остаются в work, секреты не коммитятся.

Базовая конфигурация APK — существующий com.movement.squat.staging.ui. Обычная сборка требует закреплённый ключ. Совместимая команда build:apk:staging оставлена как alias; она не создаёт отдельный сервер. [Ключ и сертификат](ANDROID_SIGNING.md).

## GitHub Actions

| Workflow | Запуск | Результат |
| --- | --- | --- |
| backend.yml | Push, PR в main, ручной запуск | Проверки; подписанный APK после push main или build_apk=true |
| checks.yml | Вызов другого workflow | Типы, формат, синтаксис, unit/integration, build, dry-run, браузеры |
| android.yml | После проверок | APK с прежним ключом, JSON, SHA-256 и manifest в artifact movement-android-<commit> |
| deploy.yml | Только ручной запуск из main с confirmation=deploy | Проверки, APK того же коммита, миграции основной D1, публикация и проверка скачивания |

Цель публикации одна. BACKEND_TARGET отклоняется. Плановая публикация не создаёт коммиты и не сливает ветки. При объединении по прямой команде владельца выполнен разовый main-выпуск с сохранением APK 2.5.4 в main; после завершения разовый триггер удалён. [Отчёт](releases/2.5.4-2026-10-23.md).

Нужны secrets STAGING_ANDROID_KEYSTORE_BASE64, CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID именно этого репозитория. Их значения уже проверены подписанным выпуском 2.5.3 и деплоем; новые версии продолжают использовать те же привязки.

Для изменений создаётся временная ветка, выполняются проверки и PR в main. Слияние и публикация — по прямой команде владельца; текущая консолидация явно разрешена. После проверки включения коммитов временные ветки удаляются.
