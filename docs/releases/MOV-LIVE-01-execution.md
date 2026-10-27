# MOV-LIVE-01 — разрешённый серверный выпуск

27 октября 2026 года владелец прямо подтвердил интеграцию PR №15/16 через общую
ветку в main, применение отсутствующих миграций основной D1 и публикацию API.
Это разрешение относится к данному выпуску 2.6.1; повторного согласования не требуется.

Кандидат кода: 90075f51a4cf3123494042f67e25c7214718ae3f, APK 2.6.1/20601.
Диагностика телефона подтвердила каталог 404 на штатном адресе при работающем
dashboard. Источники и критерии — [MOV-LIVE-01](MOV-LIVE-01.md).

## Изменения для исполнения разрешения

Коннектор GitHub умеет merge, но не workflow_dispatch; gh API из среды недоступен.
Автоматическая проверка отклонила предложенный автоматический push-trigger как
изменение постоянной release/security boundary, не разрешённое отдельно владельцем.
Этот вариант снят. deploy.yml сохраняет только workflow_dispatch из main с
confirmation=deploy. Владелец выполнил технический запуск через штатный GitHub UI (run ниже). Одобрение владельца на сам выпуск уже получено и не запрашивается повторно.
Обычный CI и ручной release workflow сохраняются; полные локальные дубли не запускаются.

Перед checks/Android/миграцией новый read-only checkpoint проверяет аккаунт и
существующую D1, получает Time Travel bookmark и версии Worker, читает только
схему, журнал миграций, числовые агрегаты и время активации. Файл без credentials
сохраняется в приватный artifact до любой миграции. Без корректной точки выпуск
останавливается. После публикации проверяются схема/guards/журнал 0005, неизменность
уже существовавшего activated_at, сохранность профилей/истории и health 2.6.1.
Time Travel restore, создание БД и прямые пользовательские UPDATE/DELETE отсутствуют.

Чистые build metadata захватываются до копирования свежего downloadable APK;
добавлена только public/app-debug.apk.json в список разрешённых временных
артефактных изменений. Версия/SHA/dirty скачанного APK сверяются до упаковки.
Изменения настоящих исходников по-прежнему останавливают release metadata guard.

Адресно выполнены: checkpoint 4 PASS, build metadata 3 PASS, YAML/bashed script
syntax и diff-check. Обязательные общие проверки выполняет финальный workflow.
API/SQL/shared contracts/распознавание/XP/Android identity/области очередей не меняются.

## Учёт результата

До завершения Actions публикация не считается успешной. Фактические main SHA,
run, checkpoint/deployment artifacts и результат remote проверки фиксируются
в PR/отчёте после выполнения. Успех preflight не означает, что миграция выполнена;
отказ после миграции требует проверки журнала и исправления вперёд.
Зависшая запись телефона проверяется прежним UUID/pendingEnd после совместимого API;
данные приложения не очищаются. Реальную очередь владельца этот workflow не трогает.

## Фактическое завершение — сверка 28 октября 2026 года

Владелец запустил [ручной release run 40584779481](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40584779481)
из main с confirmation=deploy. **Attempt 2: SUCCESS**; завершение публикации
2026-10-27T21:28:03Z (27 октября 23:28 Africa/Johannesburg).
Main/source SHA сервера, статики и APK:
`a81ced91f60bfc57ab5cb97754e2bac4c19c265e`;
tree `71280ad4c0af5dd27e020eed68fa34fd6ad9e4ad`.
Версия package.json/VERSION — 2.6.1; Android versionCode 20601; dirty=false.
Отчётные коммиты после выпуска не заменяют этот runtime/source SHA.

Интеграция: PR №16 → №15 → общая ветка; PR №17 добавил безопасные checkpoints;
[PR №10](https://github.com/rojoscarlos-cpu/APP-updated-version-/pull/10) объединил результат в main.
Рабочая цель сохранена: Worker movement-test-api-staging, D1 movement-test-app-staging,
API https://movement-test-api-staging.rojoscarlos93.workers.dev/api.
Новая база/другой сервер не создавались; прежние миграции не редактировались.

### Доказательства remote выпуска

Preflight 2026-10-27T21:12:34Z подтвердил health 2.5.4 и журнал 0000–0004:
0005 и workout_sessions отсутствовали. Это подтверждённая причина несовместимости
с установленным APK 2.6.1, а не ошибка адреса APK.

Перед изменением сохранены D1 Time Travel bookmark и предыдущая версия Worker
в приватный [preflight artifact 12771600348](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40584779481/artifacts/12771600348).
Точка действует только в пределах текущего Time Travel retention Cloudflare;
хранение artifact до января само по себе не продлевает срок восстановления БД.
Restore не выполнялся. Приватные bookmark/DB UUID в git не копируются.

Wrangler применил единственную отсутствующую миграцию:
0005_workouts_activity.sql, applied_at 2026-10-27 21:27:43 UTC.
SHA-256: `4f463af3536b838419a303e79547e659a7152621319a9fda6dcbae6efc9039ca`.
Postflight подтвердил ту же D1, запись 0005 в журнале, 8 новых таблиц,
11 новых триггеров, activated_at=1793136463259 (2026-10-27T21:27:43.259Z).
Activation до миграции отсутствовала. Контрольные количества до/после совпали:

| Проверка | До | После |
| --- | --- | --- |
| profiles | 6 | 6 |
| repetition_events | 65 | 65 |
| rounds | 3 | 3 |
| competitions | 2 | 2 |

Эти агрегаты подтверждают отсутствие потери строк по контрольным таблицам;
это не полная побайтовая сверка содержимого каждой пользовательской строки.

Опубликован Worker version ID `976e7d60-f522-435c-9a77-490cdb8ca92f`.
deployment.json: version=2.6.1, commit=a81ced91…, checks health,
anonymousRejected, guestState, logout, workoutRouteGuards — все true.
Проверены реальные catalog/activity/history маршруты: анонимному 401,
гостю без профиля 409 PROFILE_REQUIRED с JSON/private/no-store; прежний 404
отсутствующего маршрута устранён. Проверка с существующим профилем владельца
и изменение его программы из CI не выполнялись.

[Backend evidence artifact 12771212919](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40584779481/artifacts/12771212919):
deployment.json, preflight.json, postflight.json; ZIP SHA-256
`e4e63e9527aeebeaf3445897ebaf54ac9cba4a62e452a2366ab2409691437f0c`.
ZIP получен Тимлидом, digest и содержимое сверены.
Это свидетельства deployment/checkpoint, не архив Worker bundle.
Expires_at 2027-01-25T21:18:44Z; исходники Worker остаются в git.

### Итоговый APK

[Artifact 12771873326](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40584779481/artifacts/12771873326),
name movement-android-a81ced91f60bfc57ab5cb97754e2bac4c19c265e,
expires_at 2027-01-25T21:18:44Z.
ZIP SHA-256 `5e8ab722fc4ea8903f53724c2e6529840b87f21de206a006ae80840a6e1873d7`.

| Файл | Байты | SHA-256 |
| --- | --- | --- |
| app-debug.apk | 20455854 | d47da90a6aa7a4f2c3a84ffaf9740d722af952e1ae1b1ca97c82f0e59721f2f6 |
| app-debug.apk.json | 355 | 007e12090783fb9a980d675976a619c98e9217ab8bd051e92f15e66cc3439eb0 |
| app-debug.apk.sha256 | 80 | 97b0ce8ee52a88a66abb11f8506c6b187655f79b24a578cdd3772ebbcf5d8e4a |
| android-manifest.txt | 6832 | da2398477575d8e2b5bb841cfa28ae859cbce80ee64962308f4d645669bbb8ea |

Artifact получен и проверен Тимлидом: APK v2 RSA/SHA256 подпись и chunked content
digest, manifest package/versionCode/versionName, embedded build metadata
и SHA в JavaScript совпали с JSON/source. Локальные Full model/WASM сохранены.
Пакет com.movement.squat.staging.ui, сертификат SHA-256
`122721cc9aa1600dca3ba86f4318f0e3c43c3c4b562a5c8d3114ea4194dfc0de`,
API-base и области хранения сохранены.
Deploy job скачал опубликованный [APK](https://movement-test-api-staging.rojoscarlos93.workers.dev/app-debug.apk)
и сверил размер/SHA-256 с этой сборкой.

### Проверки и ограничения

Release check: typecheck, format:check, lint, unit/integration **397 PASS / 1 SKIP /
0 FAIL**, build, backend dry-run; браузеры **56/56**. Android и deploy jobs SUCCESS.
Main push CI 40584589640 также завершился успешно; локальный полный набор
для этого отчёта не повторялся.

Attempt 1 остановился до миграции: tests/browser-backend.mjs:118 прочитал textContent
ещё отсутствующего DOM-узла сразу после reload/перехода. Тот же source SHA прошёл
main CI; повторены только failed jobs и зависимые Android/deploy.
Успешный preflight использован повторно. Attempt 2 прошёл.
Тестовая гонка в этом отчётном PR не исправляется; при следующей правке этого
сценария ожидание узла следует сделать устойчивым, сохранив проверку точного счёта.

Архитектурное заключение: клиент/API/SQL готовы к повторной физической приёмке
на сохранённом профиле. Контракты/auth/идемпотентность/ревизии/пагинация не изменены
операционным выпуском; api.ts/validate.ts дополнительных правок не требуют.
Распознавание/начисления/ключ/пакет/API-base/UUID-before-send/ack-before-end сохранены.

**NOT_RUN:** реальная очередь владельца и authenticated live-сценарий с его профилем,
камера/точность/FPS/нагрев телефона. Не объявлять их исправленными по одному CI.

Следующий шаг владельца: на уже установленной 2.6.1 из 90075f51 открыть восстановление,
нажать «Проверить снова», дождаться подтверждения прежнего pendingEnd и запустить
другую программу без reload. Если pendingEnd нет — явное продолжение в пределах 24ч
или штатное прекращение. Не очищать данные, не менять API/профиль, не переустанавливать
ради восстановления. Старые UUID/endedAt сохраняются.
После успеха — оставшиеся пункты [PHONE_ACCEPTANCE](../PHONE_ACCEPTANCE.md).
События до activated_at дают фактический объём без ретро-XP по действующим правилам;
начисления проверять на новой работе после активации.
Новых пакетов разработчикам до результата телефона нет.
