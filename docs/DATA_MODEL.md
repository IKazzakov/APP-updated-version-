# Модель данных «Движения»

Точная схема задаётся актуальными [SQL-миграциями](../drizzle/), а поведение
записи — серверными запросами и триггерами. Этот документ объясняет модель;
отдельная копия итогового `CREATE TABLE` не поддерживается. После изменения
схемы обновляй описание вместе с миграцией и [API-контрактом](API.md).
Текущую версию приложения определяй по [package.json](../package.json) и
[src/config.js](../src/config.js), а не по версии старого отчёта.

## Хранилище и исполнители

Основное хранилище — Cloudflare D1 / SQLite через binding `DB` в
[wrangler.backend.json](../wrangler.backend.json). Единственная рабочая база и
архив прежнего сервера описаны в [SINGLE_SERVER.md](SINGLE_SERVER.md).
`ASSETS` обслуживает статику, `AUTH_LIMITER` ограничивает регистрацию;
это не таблицы БД. UUID основной D1 подставляется в генерируемую конфигурацию
[скриптом деплоя](../scripts/deploy-backend.mjs); UUID-placeholder в git не
является идентификатором новой базы.

Runtime ORM нет. Сервер выполняет параметризованный SQL через D1-совместимые
`prepare().bind().first()/all()/run()` и `batch()`. Название каталога `drizzle`
не означает использование Drizzle ORM. Локальный Node использует
[`node:sqlite`-адаптер](../server/sqlite.js). Порядок применения и неизменяемость
миграций описаны в [db/README.md](../db/README.md).

Набор миграций `0000`–`0005` создаёт 26 прикладных таблиц, 18 явных индексов и
25 триггеров; служебные таблицы migrator в эти числа не входят. После новой
миграции пересверь эти сведения по исходникам:

| Миграция | Изменения |
| --- | --- |
| [0000_squat_mvp.sql](../drizzle/0000_squat_mvp.sql) | Профили, соревнования, раунды, события, дневной прогресс и награды; исходный триггер прогресса |
| [0001_weekly_rankings.sql](../drizzle/0001_weekly_rankings.sql) | Старый флаг `rankings_enabled`, недельные периоды, участие, результаты, бонусы и сводки |
| [0002_ranking_defaults_duel_cancel.sql](../drizzle/0002_ranking_defaults_duel_cancel.sql) | Действующий `rankings_excluded`, отмена приглашений `cancelled_at` |
| [0003_device_sessions.sql](../drizzle/0003_device_sessions.sql) | Индивидуальные сессии устройства |
| [0004_server_optimization.sql](../drizzle/0004_server_optimization.sql) | Агрегаты и их backfill, история согласия, очередь пересчёта, курсор сводок, дополнительные индексы и триггеры |
| [0005_workouts_activity.sql](../drizzle/0005_workouts_activity.sql) | Программы, события упражнений, независимый XP, активация и защита конкурентной записи |

## Единицы и ограничения

Временные отметки — `INTEGER` Unix milliseconds; счётчики, баллы и флаги также
имеют тип `INTEGER`. `local_date` и `week` — `TEXT` с датой `YYYY-MM-DD`, `week`
обозначает понедельник. Дневной календарь использует сохранённый пояс профиля;
спортивная неделя — `Africa/Johannesburg`, понедельник 00:00 UTC+2. Проверки
формата даты, UUID, пояса и часть спортивных правил находятся в API, а не в
SQL CHECK.

FK используют стандартный `NO ACTION`, каскадов удаления нет. Таблицы не
объявлены `STRICT` или `WITHOUT ROWID`. Не усиливай существующие ограничения
только в документации: меняй схему отдельной миграцией, если это требуется
задачей.

## Профили, сессии и участие

| Таблица | Ключи и данные | Существенные особенности |
| --- | --- | --- |
| `profiles` | PK `user_id`; имя, пояс, время создания, два флага рейтинга | Имя длиной 1–40; оба флага `NOT NULL DEFAULT 0`, CHECK 0/1. Эффективное участие — `!rankings_excluded`; `rankings_enabled` сохранён как legacy |
| `device_sessions` | PK `token_hash`; UNIQUE `user_id`; `created_at`, nullable `revoked_at` | Хеш длиной 64. FK к профилю **нет**: гостевая сессия может существовать до создания профиля. Отозванная запись сохраняется |
| `ranking_consent` | PK `(user_id,changed_at)`; FK пользователя; `excluded` CHECK 0/1 | Временная история согласия; закрытие недели читает последнее значение до своего cutoff |

Отсутствие профиля у сессии не означает повреждение базы и не разрешает
создать профиль автоматически. Одинаковые отображаемые имена не объединяют
пользователей. Публичная идентичность определяется
[авторизацией устройства](../server/device-auth.js), а не входным `user_id`.
Профиль и запись истории согласия сохраняются одним batch в
[server/api.js](../server/api.js). API возвращает положительное
`rankingsEnabled`; пропущенное поле при редактировании не отменяет отказ.

## Тренировки и соревнования

| Таблица | Ключи и данные | Существенные особенности |
| --- | --- | --- |
| `competitions` | PK `id`; FK `creator_id`, nullable FK `opponent_id`; UNIQUE `token_hash`; UNIQUE `(creator_id,create_request_id)` | Правила, создание, принятие, истечение и nullable `cancelled_at`. Соперник не может совпадать с автором; принятие связывает наличие opponent/accepted/expires |
| `rounds` | PK `id`; FK пользователя и nullable FK соревнования; UNIQUE `(user_id,start_request_id)` | `kind` personal/competition согласован с наличием competition; `status` active/completed/aborted, default active; ровно 60000 мс; `count >= 0`, default 0 |
| `repetition_events` | PK `(user_id,id)`; FK пользователя и nullable FK раунда | occurred/received timestamp, local date, nullable elapsed; `round_eligible` CHECK 0/1, default 0. Ключ обеспечивает повторяемую доставку |
| `daily_progress` | PK `(user_id,local_date)`; FK пользователя | `count >= 0`, default 0; заполняется триггером событий |
| `daily_rewards` | PK `(user_id,local_date)`; FK пользователя и составной FK к дневному прогрессу | `points DEFAULT 10 CHECK(points=10)`, время выдачи; одна награда на день |

Счёт раунда обновляется только подходящими событиями своего пользователя,
пока раунд активен. Дневной прогресс сохраняется и при раннем прерывании.
Подтверждённый положительный `aborted` участвует в лучшей попытке дуэли, но
не становится минутным рекордом. Полные правила и текущие константы:
[API.md](API.md), [server/rules.js](../server/rules.js),
[server/api.js](../server/api.js), [DUEL_EARLY_STOP.md](DUEL_EARLY_STOP.md).

## Недельный учёт

| Таблица | Ключи и данные | Существенные особенности |
| --- | --- | --- |
| `weekly_settings` | `id INTEGER PRIMARY KEY CHECK(id=1)`; activated timestamp, activation week | Единственная настройка активации; повторная инициализация не сдвигает начало |
| `weekly_periods` | PK `week`; границы, версия правил, nullable закрытие | Ровно 604800000 мс; `summary_cursor DEFAULT ''`, `summaries_complete DEFAULT 0` для возобновления заполнения |
| `weekly_participants` | PK `(week,user_id)`; FK к периоду и профилю | Снимок допущенных участников при закрытии недели |
| `weekly_standings` | PK `(week,user_id)`; FK к периоду и профилю | `score > 0`, `place > 0`; зафиксированный спортивный результат и место |
| `weekly_bonuses` | PK `(user_id,week,type)`; FK пользователя; UNIQUE `basis` | CHECK: full_week →20; sport_place →5/10/20. Время выдачи; FK по `week` нет |
| `weekly_summaries` | PK `(user_id,week)`; FK к профилю и периоду | Дни, nullable лучший результат/место, participated CHECK 0/1, составляющие баллов, total, revision default 1, updated/seen timestamps и seen_total |

Семь различных награждённых дней календарной недели профиля дают бонус
full_week; спортивные места определяются полной совместимой минутой и
согласием на cutoff. Поздние допустимые события могут дополнить дневные баллы,
full_week и сводку. Зафиксированные спортивные места и награды не
перераспределяются. `seen_at` и `seen_total` позволяют сохранить просмотр и
показать последующее изменение суммы.

## Производные таблицы и источник истины

| Таблица | Ключи и данные | Назначение |
| --- | --- | --- |
| `user_totals` | `user_id TEXT PRIMARY KEY REFERENCES profiles`; points, bonus_points, revision — `NOT NULL DEFAULT 0` | Общий баланс и ревизия состояния. У user_id нет явно объявленного NOT NULL |
| `week_points` | PK `(week,user_id)`; FK пользователя; points default 0 | Материализованные дневные награды и бонусы выбранной недели |
| `weekly_best` | PK `(week,user_id,rules_version)`; FK пользователя; score CHECK >0 | Максимум положительных completed-раундов ровно по 60000 мс, раздельно по версии правил |
| `weekly_dirty` | PK `(user_id,week)`; FK пользователя; revision default 1 | Устойчивая очередь адресного пересчёта недельных итогов |

В трёх таблицах с полем `week` в этом разделе FK на период отсутствует.
Источник расчётов — исходные события, раунды, `daily_rewards` и
`weekly_bonuses`; агрегаты не заменяют эти записи. Миграция `0004` выполняет
начальный backfill. Последующие обновления поддерживают SQL-триггеры:

- `repetition_updates_progress` увеличивает дневной прогресс, выдаёт награду
  при достижении цели и увеличивает подходящий активный раунд.
- `totals_profile_insert` создаёт нулевой баланс и начальную историю согласия.
- `totals_daily_reward` и `totals_weekly_bonus` увеличивают балансы;
  дневная награда также обновляет задачу `weekly_dirty`.
- `totals_round_insert/update` увеличивают ревизию, поддерживают недельный
  максимум и ставят завершённые раунды в очередь пересчёта.
- `weekly_best_correction` пересчитывает старый максимум после изменения
  ранее завершённого раунда. Обычный API не переписывает завершённые раунды.
- `totals_profile_update`, `totals_progress_insert/update`,
  `totals_competition_insert/update`, `totals_summary_insert/update`
  увеличивают ревизию затронутых пользователей.

Триггеры не являются универсальным механизмом исправления произвольных
данных: для DELETE/UPDATE наград нет полного набора обратных пересчётов.
Административные исправления требуют отдельной задачи, анализа зависимостей,
восстановления агрегатов и проверок. Не правь агрегат вручную вместо источника.

## Индексы и конкурентная запись

Кроме индексов PK/UNIQUE, миграции объявляют:

| Индексы | Ключи |
| --- | --- |
| `rounds_one_active_per_user` | UNIQUE user_id, только status='active' |
| `rounds_competition_user` | competition_id, user_id |
| `rounds_user_history` | user_id, status, finished_at DESC |
| `rounds_weekly_results` | status, rules_version, ends_at, user_id |
| `rounds_personal_record` | user_id, status, rules_version, count DESC |
| `rounds_active_deadline` | status, ends_at |
| `competitions_opponent` | opponent_id |
| `competitions_creator_history` | creator_id, created_at DESC, id DESC |
| `competitions_opponent_history` | opponent_id, created_at DESC, id DESC |
| `daily_rewards_date` | local_date, user_id |
| `weekly_bonuses_week` | week, user_id |
| `user_totals_rank` | points DESC, user_id |
| `week_points_rank` | week, points DESC, user_id |
| `weekly_best_rank` | week, rules_version, score DESC, user_id |

PK события защищает от дублей. Триггеры выполняются в транзакции исходной
записи; `DB.batch()` атомарен. Частичный UNIQUE запрещает две активные попытки
одного пользователя. Условные UPDATE защищают принятие/отмену приглашения и
завершение раунда. Не полагайся только на предварительный SELECT.

Весь HTTP-запрос или Cron не является единой транзакцией. В
[maintenance.js](../server/maintenance.js) прерывание просроченных активных
раундов — отдельный UPDATE; закрытие каждого периода — batch участия,
результатов, наград и `closed_at`. Сводки обрабатываются отдельными batches.
Удаление задачи `weekly_dirty` проверяет выбранную ревизию, чтобы не потерять
изменения, пришедшие во время обработки. Cron работает ограниченными порциями,
курсор позволяет продолжить заполнение после перерыва.

## Проверка изменений

Для схемы проверяй чистое создание и обновление существующей БД штатным
migrator, FK и CHECK, backfill, сохранность строк и откат при ошибке. Основные
проверки модели: [server.test.js](../tests/server.test.js),
[weeks.test.js](../tests/weeks.test.js),
[optimization.test.js](../tests/optimization.test.js),
[cloudflare.test.js](../tests/cloudflare.test.js),
[node-runtime.test.js](../tests/node-runtime.test.js).
[server-consolidation.test.js](../tests/server-consolidation.test.js)
дополнительно фиксирует допустимость гостевых сессий без профиля и сохранение
данных при историческом ограниченном переносе. Он не разрешает новый перенос
или изменение архивной базы.

Полный порядок локальной работы и CI — [DEVELOPMENT.md](DEVELOPMENT.md),
обязанности backend — [team/BACKEND.md](team/BACKEND.md). Remote-миграции и
публикация требуют прямой команды владельца; локальные проверки используют
изолированные данные.


## Программы и активность · миграция 0005

[0005_workouts_activity.sql](../drizzle/0005_workouts_activity.sql) добавляет
8 таблиц, 4 явных индекса и 11 триггеров. Итог 0000–0005:
26 прикладных таблиц, 18 явных индексов и 25 триггеров.
Служебная movement_migrations в эти числа не включена.
Прежние миграции и существующие строки не изменяются.

| Таблица | Ключи и назначение |
| --- | --- |
| activity_settings | Единственная строка id=1 с activated_at. Время активации создаётся миграцией и сохраняется при повторном открытии БД |
| workout_sessions | PK id, владелец-профиль, program_id/version/rules_version, зафиксированный program_json, started/finished timestamp, active/completed/aborted и active_ms |
| workout_steps | PK (workout_id,step_index), упражнение, target и progress; FK выполнения и CHECK 0<=progress<=target |
| workout_events | PK (user_id,id COLLATE NOCASE), FK (workout_id,step_index), occurred_at и nullable duration_ms; авторитетные события программы |
| activity_events | PK (user_id,id COLLATE NOCASE), упражнение, время, длительность удержания и received_at; общий факт активности legacy/program |
| activity_event_parts | PK (user_id,event_id COLLATE NOCASE,local_date), FK факта; фактический объём и отдельно объём, допустимый для XP после activated_at |
| activity_days | PK (user_id,local_date), накопленные squats/pushups/plank_ms, допустимый XP-объём и дневной XP |
| activity_totals | PK user_id с FK профиля, total_xp и revision; новый баланс отдельно от прежнего user_totals.points |

Удержание планки длительностью 1–1000 мс разбивается на части в календарных
днях профиля; разделение учитывает полночь, IANA timezone и границу активации.
XP дня = MIN(300,xp_squats+xp_pushups+floor(xp_plank_ms/5000)).
Округление выполняется после накопления времени; паузы и пропуски кадров не
поступают в журнал как корректное время.

workout_event_guard защищает порядок подходов, предел цели, закрытое выполнение
и повтор UUID с изменёнными данными. activity_event_guard исключает конфликт
факта и перекрывающиеся plank-интервалы. UUID сопоставляются без различия регистра.
Старт программы/минуты проверяется SQL-триггерами, включая конкурентные запросы.
Пакет событий, прогресс, части активности и legacy-mirror сохраняются одной batch.

Программное приседание зеркалируется в repetition_events с тем же UUID;
новые отжимания/планка не маскируются под приседания. Триггер старого события
тоже создаёт общий факт активности. Части и UUID обеспечивают однократный XP
независимо от пути доставки. Начисления до activated_at не возникают.

Исторические daily_progress не копируются в новый XP-журнал: readActivity
объединяет прежние подтверждённые дни и новую активность для непрерывной серии.
Первоначальный activity_totals содержит по нулевой строке существующего профиля.
Новый профиль получает нулевую строку через activity_profile_insert.
Проверка исторического ограниченного импорта учитывает только такую добавочную
нулевую строку; сам перенос этой задачей повторно не запускается.

activity_totals.revision вместе с user_totals.revision формирует монотонную
ревизию ActivityProgress. При одинаковой ревизии клиент сравнивает serverNow.
Таблицы daily/totals являются производными; события, их части и зафиксированные
цели сохраняются источником расчётов. Произвольные UPDATE/DELETE для пересчёта
не поддерживаются без отдельного спроектированного исправления.

Новые API и ошибки описаны в [API.md](API.md), продуктовые решения —
[WORKOUT_RULES_V0_1.md](product/WORKOUT_RULES_V0_1.md).
Проверки чистой БД, upgrade с данными, повторного migrator, FK, rollback,
UUID-conflict, XP, series и гонок: tests/workouts-migration.test.js,
tests/workouts-server.test.js и tests/workout-contracts.test.js.
