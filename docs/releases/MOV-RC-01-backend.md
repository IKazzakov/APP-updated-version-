# MOV-RC-BE-01 — подготовка совместимого Worker

Дата: 27 октября 2026 года. Статус: локальная подготовка завершена;
remote-миграции, публикация и резервная точка удалённой D1 **не выполнялись**.

## База и границы

- Пакет: [MOV-RC-01](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/7a9b4295b2af8988af4493dd7520ad22060923ea/docs/team/MOV_RC_01.md).
- Исходный commit: c4131161b82066bba3c83901b8c6984aa0b47eaf, PR №6,
  ветка codex/programs-mvp-20261026. Проверена main cf50e27419ffba4b3fd0caa5771b067b1ad407fa.
- Версия исходников: 2.5.4 в package.json и src/config.js. Кандидат 2.6.0/20600
  подготавливает Frontend; Backend номер версии не меняет.
- Изменены только scripts/deploy-backend.mjs, tests/backend-deploy.test.js
  и этот отчёт. API, SQL, wire-типы, UI и workflows не изменены.
- Единственный Worker: movement-test-api-staging; существующая D1:
  movement-test-app-staging; API-base:
  https://movement-test-api-staging.rojoscarlos93.workers.dev/api.
  Исходный Test и архивная D1 не затрагиваются.

## Поведение проверки выпуска

Сохраняются health/version, anonymous state, регистрация штатного гостя,
v2/dashboard, state и logout. VERSION читается из src/config.js.

Для каждого GET /api/v2/workouts/catalog, /api/v2/activity и
/api/v2/workouts/history?limit=1 проверяются:

| Состояние | Обязательный результат |
| --- | --- |
| Без Bearer | HTTP 401, application/json, error.code=DEVICE_AUTH_REQUIRED |
| Гость без профиля | HTTP 409, application/json, error.code=PROFILE_REQUIRED, Cache-Control private и no-store |

HTML, повреждённый JSON, другой MIME/status/code, отсутствие маршрута и сбой
сети останавливают smoke. Fallback на v1 отсутствует. После любой ошибки новых
проверок finally вызывает logout для созданной сессии. Итоговые flags сохраняются,
checks.workoutRouteGuards=true добавляется только при полном успехе; штатный
deployment.json получает этот flag через существующий report.checks.

Smoke создаёт и отзывает только собственную гостевую сессию. Он не создаёт
профиль, программу, событие или XP. Это проверка маршрутизации и guards,
**не доказательство применения 0005**, работы авторизованного профиля или камеры.
При потере связи во время logout отзыв нельзя гарантировать; smoke не сообщает успех.

## Фактически выполненные проверки

Среда: Node.js 24.19.0, npm 11.9.0, Wrangler 4.92.0.

| Команда | Результат |
| --- | --- |
| node tests/backend-deploy.test.js | 90 PASS, 0 FAIL |
| node tests/workouts-migration.test.js | 5 PASS: clean, upgrade с данными, повторный migrator, XP cutoff, rollback |
| node tests/workouts-server.test.js | 20 PASS |
| node tests/workout-contracts.test.js | 3 PASS |
| npm run typecheck | PASS |
| npm run format:check | PASS |
| npm run lint | PASS |
| npm test | 375 зарегистрировано, 374 PASS, 1 условный SKIP, 0 FAIL |
| npm run build | PASS |
| npm run backend:validate | PASS, deploy --dry-run |
| git diff --check | PASS |

Первый npm test остановился на listen EPERM из-за сетевой песочницы.
Повтор с доступом к локальным портам прошёл полностью. Условный SKIP — отдельный
Chromium/IndexedDB-тест; в этой задаче он и браузерный/физический сценарии не запускались.
Успешный smoke использует настоящий публичный Worker с изолированной SQLite.
81 отрицательный подслучай проверяет три маршрута с/без сессии: HTML/JSON/MIME,
200/201/404/500, неверные status/code/shape, transport и гостевой cache policy.
Отдельно воспроизведён старый Worker с рабочим auth, но отсутствующим v2 route.
После каждого отказа проверены отзыв сессии и отсутствие профилей/активности/наград.

## Подготовленные артефакты

Локально (не коммитить): work/backend/dry-run/{cloudflare.js,cloudflare.js.map,README.md},
work/backend/{build.log,worker-dry-run.log,backend-deploy-direct.tap,
typecheck.log,format-check.log,lint.log,unit-integration.log,workouts-migration.log,
workouts-server.log,workout-contracts.log}. Пакет передачи содержит эти файлы,
отчёт, SHA256SUMS и manifest.json с точным исходным commit/деревом.
Это подготовительный bundle, а не публикация и не самодостаточный APK/статика.

SHA-256 неизменённой drizzle/0005_workouts_activity.sql:
4f463af3536b838419a303e79547e659a7152621319a9fda6dcbae6efc9039ca.

SHA-256 dry-run cloudflare.js:
cf5e45e96a61c18f28ac7777bc78df04cba05b52ed7282ec067f022f8a2295da.

Dry-run проверил DB, ASSETS, AUTH_LIMITER и прочитал 20 файлов dist/client.
Рабочий database_id при dry-run не запрашивался; placeholder не заменяет D1.
Текущая сборка содержит прежний public APK; она не является кандидатом 2.6.0.
Перед выпуском после интеграции обязательна новая сборка Worker/статики/APK одного commit.

Воспроизводимая локальная подготовка из отдельной чистой копии согласованного commit:

```sh
npm ci
node tests/backend-deploy.test.js
node tests/workouts-migration.test.js
node tests/workouts-server.test.js
node tests/workout-contracts.test.js
npm run typecheck
npm run format:check
npm run lint
npm test
npm run build
npm run backend:validate
sha256sum drizzle/0005_workouts_activity.sql work/backend/dry-run/cloudflare.js
git diff --check
```

## Будущий разрешённый выпуск — сейчас НЕ запускать

1. Тимлид интегрирует BE/FE в общую ветку; владелец отдельно разрешает merge main
   и выпуск. Зафиксировать итоговый main SHA. Пересобрать APK и Worker того же SHA:
   version 2.6.0/20600, прежний package, API и сертификат. Подтвердить SHA-256 APK,
   manifest и совместимость. Чужой/предварительный APK — условие остановки.
2. До remote-записи проверить аккаунт и **существующую** movement-test-app-staging,
   сохранить её UUID, текущую версию Worker и D1 Time Travel bookmark в закрытом
   артефакте выпуска. Подготовительный placeholder UUID не использовать.
   Штатная configured identity/Actions secrets; значения секретов не печатать.
   Пример будущих read-only команд (с текущей авторизацией владельца):

```sh
mkdir -p work/backend
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=work/backend/preflight.log npx wrangler d1 info movement-test-app-staging --json > work/backend/d1-before.json
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=work/backend/preflight.log npx wrangler d1 time-travel info movement-test-app-staging --json > work/backend/d1-bookmark-before.json
```

   Если БД/аккаунт не совпадает, bookmark недоступен, срок восстановления не покрывает
   выпуск, исходный SHA/0005 изменились или проверки не прошли — остановиться.
   Проверить текущий список миграций/схему и неизменность 0000–0005; не создавать D1.
3. Штатный путь после разрешения: Actions **Movement — manual deployment**,
   ветка main, confirmation=deploy (.github/workflows/deploy.yml).
   Он выполняет checks → подписанный APK этого SHA → build со свежим APK →
   npm run backend:deploy → проверку опубликованного APK → артефакт выпуска.
   Не запускать этот workflow и отдельный npm run backend:deploy одновременно.
4. deploy-backend.mjs выбирает существующую D1 и формирует
   work/backend/wrangler.generated.json с её настоящим UUID. Затем последовательно
   выполняет d1 migrations apply DB --remote и deploy, после чего smokeBackend.
   0000–0004 не переписываются; 0005 применяется штатным migrator один раз.
   Не исполнять SQL вручную вне журнала и не применять DOWN/DROP.
5. Зафиксировать persisted activity_settings.activated_at и журнал миграции
   в закрытом отчёте. XP начинается этим временем, **не запуском нового APK**:
   старые активные клиенты после миграции уже создают activity через legacy-триггер.
   Старые points не конвертируются; исторические дни восстанавливают серию без ретро-XP.
6. Проверить deployment.json: точный commit/version, health, guestState, logout и
   workoutRouteGuards=true. Workflow сверяет опубликованный APK с метаданными
   и полным SHA-256. Затем выполнить отдельную разрешённую приёмку на телефоне
   по FE-протоколу: обновление поверх 2.5.4, сохранность credentials/очереди/истории,
   четыре программы, XP/серия, offline/ack/partial и прежняя минута/дуэль.
   Новые профили/занятия не добавлять автоматическим smoke в основную БД.

## Восстановление при неуспехе

| Момент отказа | Действие и сохранение данных |
| --- | --- |
| До remote-миграции | Остановить выпуск; исправить сборку/ключ/аккаунт/проверки. БД и установленный APK не менять; прежний Worker продолжает работу. |
| Во время миграции | Не предполагать итог по exit code: сверить журнал Wrangler, схему и activated_at. Прекратить публикацию до выяснения состояния. Исправление — отдельным согласованным добавлением, применённую 0005 не редактировать. |
| После 0005, до совместимого Worker | Сохранить новую схему и persisted activation. Старые клиенты уже могут начислять XP через legacy-мост. Устранить ошибку упаковки/сети и повторить штатный выпуск совместимого commit: migrator пропустит применённую 0005. Старый Worker можно временно оставить для прежних режимов, но программы ему не отдавать. |
| После Worker, до выдачи нового APK | Провал smoke/проверки APK означает неуспешный выпуск. Сохранить логи и D1; исправить и повторно выпустить совместимый Worker/статику/APK. Не выдавать download за проверенный кандидат до совпадения SHA. |
| После появления новых выполнений/локальных журналов | Восстановить совместимый API с sync/finish/abort/history/activity и той же D1; предпочтительно исправление вперёд либо проверенный совместимый Worker. Старый Worker не финализирует программы. Не удалять/перепривязывать очередь, не отзывать чужие сессии и не переустанавливать APK с очисткой данных. |

Повтор remote-команд и любое переключение Worker требуют команды владельца инцидента.
Локальный pass не разрешает эти действия. Нельзя объявлять rollback успешным,
пока новые журналы не доставляются с прежними UUID и подтверждёнными XP.

Time Travel restore — не обычный откат кода: он может потерять **все** записи
после bookmark, включая старые клиенты, сессии, награды и новые программы.
При подтверждённой порче сначала сохранить текущее состояние и новые факты,
оценить интервал потери и получить отдельное решение владельца по восстановлению
и согласованному переносу фактов. В этом пакете restore не выполняется и не
предлагается как автоматический шаг. Профили/таблицы/очереди не очищаются.

## Передача Тимлиду и Frontend

PR направлен в codex/programs-mvp-20261026, не main. Итоговые PR/SHA и
пакет артефактов указываются в сообщении передачи. Общие wire-файлы остаются
у Тимлида. Frontend получает неизменный контракт c413116 и требование совместимого
API до полного сценария 2.6.0. Подписанный APK и физическая приёмка здесь не выполнены.
