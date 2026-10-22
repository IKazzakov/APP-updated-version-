# Основной репозиторий и разработка

Основной проект — `rojoscarlos-cpu/APP-updated-version-`, ветка `main`, версия 2.5.3. Принятая база переноса — `d0c2f384589aa358dbcdb78c3f717e5832166bb4`. Предыдущие планы и отчёты описывают историю реализации, а не состояние секретов и размещений этого репозитория.

## Рабочий процесс

1. Получить актуальную `origin/main`, создать отдельную ветку задачи.
2. Внести согласованные изменения, выполнить подходящие проверки, отправить ветку и открыть PR в `main`.
3. Слияние — по прямой команде владельца. Обычный push не публикует Cloudflare.
4. Публикация сервера — отдельное решение и ручной workflow. Production всегда из `main`.

Клиент: ES modules и постепенно вводимый строгий TypeScript, Vite, Capacitor, без React. Камера и распознавание остаются в существующем движке; экраны, состояние, навигация, API, очередь и диагностика выделены в модули. Сервер: Workers + D1, API v1/v2, обслуживание по Cron. Применённые SQL-миграции не редактируются.

## Локальные проверки

Node.js 24+, `npm ci`, затем:

```sh
npm run typecheck
npm run format:check
npm run lint
npm test
npm run build
npm run backend:validate
```

`backend:validate` — только dry-run. Для браузерного набора:

```sh
npm install --prefix work/browser-tools --no-save playwright-core@1.58.2
NODE_PATH="$PWD/work/browser-tools/node_modules" CHROMIUM_PATH=/usr/bin/chromium npm run test:browser:all
```

Нужны локальные порты и установленный Chromium/Chrome. Базовый набор: 176 unit/integration-тестов и 47 браузерных сценариев. Дополнительная проверка настоящей модели — `npm run test:browser:model` на отдельном локальном стенде, описанном в VALIDATION.md. Синтетическая камера не подтверждает точность и скорость телефона.

## Android-среда

Нужны полный JDK 21 с `javac`, Android SDK Platform 36, Build Tools 36.0.0, platform-tools и принятые лицензии. Gradle 8.14.3 загружает wrapper проекта. В текущей среде установлены Temurin JDK 21.0.13, SDK Platform 36, Build Tools 36.0.0 и platform-tools; проверены javac, aapt, apksigner и запуск wrapper. Среда находится в игнорируемом work/android-env, а не в git.

`scripts/android-env.sh` можно подключить через `source`. Он сохраняет явно заданные `JAVA_HOME`/`ANDROID_HOME`; по умолчанию использует `work/android-env/jdk` и `work/android-env/sdk`. Кэши остаются в `work/`. Системные каталоги менять не требуется. Команда подготовки и сборки `scripts/setup-and-build-apk.sh` использует совместимый Android-пакет.

Проверить инструменты: `javac -version`, `sdkmanager --list_installed`, `aapt version`, `apksigner version`, `android/gradlew --version`. В среде с прокси Java/Gradle также нужны его штатные настройки и доверенный CA. Для подготовленной облачной среды source-скрипт также подключает игнорируемый `work/android-env/local.env` с настройками штатного прокси и CA. Настройки текущей машины и секреты не коммитятся.

Ключ подписи восстанавливается отдельно: [ANDROID_SIGNING.md](ANDROID_SIGNING.md). Без правильного ключа выпуск обновления останавливается. Нельзя заменить ключ для обхода ошибки сборки.

## GitHub Actions

| Workflow | Когда выполняется | Результат |
| --- | --- | --- |
| `backend.yml` — Movement — checks and APK | Push любой ветки, PR в main, ручной запуск | Проверки; APK после push main или ручного build_apk=true |
| `checks.yml` | Вызов другим workflow | Типы, формат, синтаксис, тесты, сборка, Worker dry-run, браузерный набор |
| `android.yml` | Вызов после успешных проверок | Подписанный APK, метаданные, SHA-256 и Android manifest в artifact `movement-android-<commit>` |
| `deploy.yml` — Movement — manual deployment | Только ручной запуск | Повторные проверки, APK из того же коммита, публикация выбранного сервера и проверка скачивания |

CI использует Node.js 24, JDK 21, SDK 36 и Build Tools 36.0.0. Права содержимого репозитория — только чтение: автоматической записи APK в ветку и автоматического слияния нет. При отсутствии постоянного ключа Android job завершается понятной ошибкой; браузерные проверки от секретов не зависят.

Необходимые repository secrets:

- `STAGING_ANDROID_KEYSTORE_BASE64` — прежний закрытый ключ установленного приложения. Имя секрета сохранено ради совместимости.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — только для ручной публикации.

[Настройка secrets этого репозитория](https://github.com/rojoscarlos-cpu/APP-updated-version-/settings/secrets/actions). Секреты нельзя прочитать обратно через GitHub API или скопировать простым переносом исходников. Добавление выполняется из резервной копии либо из исходного защищённого хранилища владельца. Наличие секретов проверяется реальной сборкой/публикацией; исторический успешный CI другого репозитория не является подтверждением.

Ручной workflow должен присутствовать в основной ветке, чтобы GitHub показал кнопку Run workflow. До согласованного слияния можно проверить ветку через push/PR и локальные инструменты. Публикацию для проверки CI запускать не требуется.

## Адреса и совместимость

Production: `movement-test-api` / D1 `movement-test-app`.
Staging: `movement-test-api-staging` / D1 `movement-test-app-staging`.
Это существующие ресурсы, общие с прежним источником; независимость репозитория не означает независимость сервера.

Текущий Android-пакет остаётся `com.movement.squat.staging.ui` и использует staging API. Переназначение `main` не переносит профили между серверами. Переход установленного приложения на рабочий API требует отдельного выпуска. Рабочие миграции и деплой не выполняются автоматически при слиянии.
