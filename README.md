# Движение · Счётчик приседаний

Основной репозиторий — [rojoscarlos-cpu/APP-updated-version-](https://github.com/rojoscarlos-cpu/APP-updated-version-), общая ветка — **main**, версия — **2.5.4**. Рабочие ветки временные: после проверки и слияния их изменения остаются в main.

## Один основной сервер

**https://movement-test-api-staging.rojoscarlos93.workers.dev**

Это единственный основной backend приложения. Слово `staging` осталось в техническом имени существующего ресурса: сохранение адреса позволяет установленным приложениям использовать прежние профили, UUID очереди и маркеры раундов. Выбора между двумя серверами в CI и сборке больше нет.

Worker — `movement-test-api-staging`, D1 — `movement-test-app-staging`. Старый Worker `movement-test-api` удалён после сохранения его профиля и сессий в общей базе; прежняя D1 сохранена архивом. Подробности и проверяемые условия: [SINGLE_SERVER.md](docs/SINGLE_SERVER.md), [проверенный выпуск 2.5.4](docs/releases/2.5.4-2026-10-23.md).

## Android

| Поле | Значение |
| --- | --- |
| Название | Движение Тест UI |
| Пакет | `com.movement.squat.staging.ui` |
| Версия / versionCode | 2.5.4 / 20504 |
| APK | [Скачать с основного сервера](https://movement-test-api-staging.rojoscarlos93.workers.dev/app-debug.apk) · [файл в main](public/app-debug.apk) |
| Метаданные / SHA-256 | [public/app-debug.apk.json](public/app-debug.apk.json) · [SHA-256](public/app-debug.apk.sha256) |
| Сертификат SHA-256 | `122721cc9aa1600dca3ba86f4318f0e3c43c3c4b562a5c8d3114ea4194dfc0de` |

Устанавливать поверх «Движение Тест UI» без удаления приложения. Пакет, ключ и адрес API сохраняются. Название установленного пакета пока сохранено ради узнаваемости; оно не означает отдельный тестовый сервер.

1. При первом запуске нажать **Быстрый старт (Гость)** или ввести имя и нажать **Начать**. `401 DEVICE_AUTH_REQUIRED` до входа ожидаем.
2. Открыть **Тренировка → Начать** и разрешить камеру. Микрофон не нужен.
3. Дождаться подтверждения очереди перед выходом или очисткой данных.

Интерфейс: «Сегодня», «Тренировка», «Соревнования», «Мой прогресс» и профиль. Диагностика с настройками подключения доступна на всех экранах. Видео, звук и координаты тела не отправляются на сервер; MediaPipe Pose Full и WASM находятся в приложении.

Дневное задание — 10 повторений и +10 баллов за первое выполнение дня. Полная календарная неделя даёт +20. В вызове сравнивается лучшая из трёх попыток: положительный подтверждённый счёт ранней остановки учитывается, а раунд остаётся aborted. Минутные рекорды и спортивный рейтинг требуют completed за полные 60 секунд. [Полные правила API](docs/API.md).

## Разработка

Нужны Node.js 24+ и npm; зависимости закреплены в lockfile.

```sh
npm ci
npm run typecheck
npm run format:check
npm run lint
npm test
npm run build
npm run backend:validate
```

`backend:validate` — только dry-run. Браузерный набор использует отдельные SQLite, тестовые профили и искусственную камеру:

```sh
npm install --prefix work/browser-tools --no-save playwright-core@1.58.2
NODE_PATH="$PWD/work/browser-tools/node_modules" CHROMIUM_PATH=/usr/bin/chromium npm run test:browser:all
```

Node-предпросмотр — `npm run dev`; локальный Sites-предпросмотр — `npm run dev:sites`. Для камеры требуется HTTPS или localhost. Настоящие движения, звук, частота кадров и нагрев Galaxy S23 проверяются на телефоне.

Для APK нужны полный JDK 21, SDK 36, Build Tools 36.0.0 и постоянный ключ:

```sh
source scripts/android-env.sh
npm run build:apk
```

`build:apk:staging` сохранён как совместимый alias той же идентичности приложения. Обычная сборка тоже использует закреплённый ключ; другой пакет автоматически не создаётся. Результат — `work/artifacts/app-debug.apk`, JSON и SHA-256.

## CI и публикация

Push и PR запускают проверки. После успешного push main собирается подписанный APK. **Movement — manual deployment** публикует только один основной сервер и только из main, после явного подтверждения `deploy`. Селектор цели и BACKEND_TARGET удалены.

Секреты: `STAGING_ANDROID_KEYSTORE_BASE64` (прежнее имя для совместимости), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Значения не входят в git или APK. Обычный push не публикует сервер. Разовый выпуск объединения завершён по прямой команде владельца; его триггер удалён.

## Документация

- [Старт трёх рабочих чатов: подробные однократные промпты](docs/team/START_PROMPTS.md).
- [Общий контекст команды](docs/TEAM_CONTEXT.md), [правила агента](AGENTS.md), [модель данных](docs/DATA_MODEL.md).
- [Один сервер и сохранение данных](docs/SINGLE_SERVER.md).
- [Рабочий процесс, CI и Android-среда](docs/DEVELOPMENT.md).
- [Cloudflare и публикация](docs/CLOUDFLARE_SETUP.md).
- [Архитектура клиента](docs/CLIENT_ARCHITECTURE.md), [API](docs/API.md).
- [Подпись Android](docs/ANDROID_SIGNING.md), [установка и проверка](docs/ANDROID_TESTING.md), [первый запуск](docs/TEST_UI_FIRST_START.md).
- [Локальный предпросмотр](GOOGLE_AI_STUDIO.md), [проверки](VALIDATION.md).
