# MOV-MVP-01: согласованный пакет интеграции

База main: cf50e27419ffba4b3fd0caa5771b067b1ad407fa (2.5.4).
Рабочая ветка: codex/programs-mvp-20261026.
Все работают в /workspace/work/movement-programs. Не коммитить чужие файлы.

Решения владельца 26.10.2026: приседания, отжимания, планка; круговая программа;
планка накапливает корректные секунды после пауз/потерь; пропуск упражнений и
ручная коррекция запрещены, раннее прекращение всей программы сохраняет частичный итог.
Конструктор и редактирование шаблонов отложены, программы задаёт разработчик.
XP 1/squat, 1/pushup, 1/5000ms plank, максимум300/день профиля, уровень=1+floor(totalXP/100).
Серия день>=10 единиц; несколько занятий суммируются; старая выполненная цель может восстановить серию.
XP с активации новой миграции, без конвертации старых баллов. Старые данные не удалять.
Пример9 пользователь отложил: временно сохраняем старую семантику минут и приседаний,
новые push/plank не маскируем под squat. Это НЕ новое принятое правило сравнения упражнений.
Все устаревшие примеры о непрерывной планке заменены последним Q3.
Никаких merge main, remote migrations/deploy.

## Владелец общих контрактов

root единолично пишет src/shared/contracts/workouts.ts, api.ts, validate.ts и
src/shared/contracts/validate-workouts.ts; root также пишет каталог
src/shared/workouts/catalog.ts (общий ES module, TypeScript erasable).
Из серверного JS можно импортировать этот .ts в Node24 и через bundler.

## Каталог

type ExerciseId = 'squat'|'pushup'|'plank';
WorkoutProgram {id:string,version:1,title:string,rounds:number,restMs:number,steps:WorkoutStep[]}
WorkoutStep {exercise:ExerciseId,target:number,unit:'reps'|'ms'}.
id squats-5-v1: squat target5;
pushups-5-v1: pushup target5;
plank-15-v1: plank target15000;
starter-circuit-v1: pushup5 -> squat5 -> plank15000, rounds1.
Начальный restMs10000 только между подходами, без отдыха после финального.
Экспорт WORKOUT_PROGRAMS (readonly), WORKOUT_RULES_VERSION='workout-v1',
findWorkoutProgram(id), expandWorkoutSteps(program) -> WorkoutStep[].
Определённые сервером цели/версии, неизвестный programId отклоняется.

## Новый HTTP контракт (не меняет v1/v2 legacy)

Только /api/v2. Все business endpoints требуют текущую сессию, профиль и Origin
для POST, JSON, private/no-store. Новый transport идёт через существующий src/api.js
с path 'v2/...', без createDataClient fallback в старый API.
Новое тело сначала проверяется runtime parser, потом применяется клиентом.
Нет нового auth, сервера или видеоданных.

GET /api/v2/workouts/catalog -> {programs:WorkoutProgram[],rulesVersion:'workout-v1',serverNow:number}
GET /api/v2/activity -> ActivityProgress
POST /api/v2/workouts/sync ->
{
 workout:{id:UUID,programId:string,startedAt:UnixMs},
 events:[{id:UUID,stepIndex:nonnegativeInt,occurredAt:UnixMs,durationMs?:int}]
}
Реп = ровно1, durationMs отсутствует. Планка durationMs1..1000, occurredAt — НАЧАЛО
валидного отрезка, отрезок [occurredAt,occurredAt+durationMs). Сервер проверяет
соответствие unit каталогу; не доверяет exercise/target из клиента.
Пачка0..100 событий (0 допустим для импорта офлайн-старта).
UUID устойчивый, метаданные workout_id неизменны. Дубликат техже данных безопасен;
конфликт того же id с другими данными409 REQUEST_REUSED.
События не старше7д, не более5с в будущем; внутри startedAt..startedAt+24ч.
Метаданные offline-start принимаются до8д назад (24чвыполнения+7ддоставки),
но события и endedAt сохраняют семидневное окно.
Накопленный объём подхода не превышает target, превышение400 WORKOUT_TARGET_EXCEEDED.
Переходы между упражнениями происходят локально после устойчивой записи;
доставка может догнать позже. Старты новой программы/минуты не прерывают чужую активную.

Ответ SyncReply {accepted:number,duplicate:number,workout:WorkoutView,progress:ActivityProgress}.
POST /api/v2/workouts/:id/finish с {endedAt:UnixMs,activeMs:nonnegativeInt};
POST /api/v2/workouts/:id/abort с тем же.
Ответ EndReply {workout:WorkoutView,progress:ActivityProgress}.
Клиент вызывает только после подтверждения ВСЕЙ локальной очереди.
finish требует все цели, иначе409 WORKOUT_INCOMPLETE; abort частичный.
endedAt>=startedAt, <=startedAt+24ч, <=now+5с, activeMs<=endedAt-startedAt.
Поздняя доставка финального итога разрешена в том же семидневном окне.
Повтор безопасен; aborted не повышается до completed; закрытый результат не переписывается.
Статус legacy rounds не меняется новым завершением.
Не хватает профиля409 PROFILE_REQUIRED, чужой id404 WORKOUT_NOT_FOUND.
GET /api/v2/workouts/history?limit=20&cursor=... -> Page<WorkoutView>
limit1..100, keyset по startedAt DESC,id DESC, курсор валидируется,
владелец всегда из сессии, nextCursor|null; включает завершённые/прерванные, не active.

WorkoutView {
 id:string,programId:string,programVersion:1,rulesVersion:'workout-v1',
 startedAt:number,finishedAt:number|null,status:'active'|'completed'|'aborted',
 stepProgress:number[],activeMs:number
}
stepProgress по expandWorkoutSteps, единицы как у шага.
ActivityProgress {
 rulesVersion:'activity-v1',activatedAt:number,version:number,
 totalXp:number,level:number,xpInLevel:number,xpForNextLevel:100,
 today:{date:string,squats:number,pushups:number,plankMs:number,units:number,xp:number,goal:10,completed:boolean},
 streak:{current:number,best:number},serverNow:number
}
version монотонна для данных пользователя; старый ответ не откатывает UI.
Непрерывная серия привязана к today если выполнен, иначе вчера; лучший период хранит/вычисляет всю историю.
Планка разделяется на локальные дни при пересечении полуночи; округление после суммирования.
Legacy repetition_events после активации тоже дают новый XP ровно раз;
новые программные squat повторения также сохраняют прежний дневной прогресс.
До активации XP нет, но прежние daily_progress>=10 могут восстановить серию.
Один UUID не должен давать XP и через program, и через legacy два раза.
Старые points не удаляются/не конвертируются; новый главный показатель XP.
История событий и earnedXP — авторитетны, не число произвольных завершённых шаблонов.

## Пакеты и границы

MOV-BE-01: backend владеет server/workouts.js, server/activity.js (если нужно),
server/api.js (тонкая маршрутизация + запрет нового legacy start поверх известного workout),
drizzle/0005_*.sql + drizzle/meta/_journal.json, tests/workouts-server.test.js,
tests/workouts-migration.test.js. Не меняет shared contracts и UI.
Согласовать migration_upgrade с существующими таблицами/данными; applied0000..0004 не менять.

MOV-FE-01: frontend владеет новым src/features/workouts/**, src/services/workouts.ts,
src/services/workout-storage.ts, src/app/bootstrap.ts/registry.ts, src/shared/feature.ts,
features/today,progress и допустимой тонкой интеграцией training.
Новый runner может использовать отдельные Camera/Vision/overlay, НЕ одновременно
с существующим Training. Lifecycle старого минутного режима сохраняется.
Камера явная; устойчивая IndexedDB-запись до перехода, каждый UUID записан до отправки;
ошибка хранилища останавливает учёт; пауза/фон/reload не начисляют plankMs.
Сохранить текущую светлую стилистику и четыре раздела, пользовательских форм конструктора нет.
Каталог доступен из Сегодня, большой счёт/цель, упражнение, следующая цель, pause/resume/stop,
подтверждённый/ожидающий итог, история программ, XP/серия.
Профиль/сервер/выход изолируют владельца очереди; нет stale response contamination.
Подготовка/logout не теряет pending.
Только явное продолжение<=24ч, доавторизованный профиль/локальные ресурсы нужны для offline.

MOV-ALG-01: отдельный алгоритмический исполнитель владеет новыми
src/algorithms/pushup.ts,plank.ts, tests/bodyweight.test.js, не меняет squat-v1.
API сообщает напрямую frontend-агенту; root интегрирует общие контракты.

root: контракты/валидаторы, этот пакет, утверждённые правила, docs/API.md,
docs/DATA_MODEL.md при новой схеме, архитектурная интеграция, итоговые проверки и PR.

## Проверки и приёмка

Проходят все4 программы, цели и порядок верны; paused/invalid/invisible intervals
не создают hold/rep; планка накапливает после пауз. Нельзя skip/manual.
Дубликаты/потерянный ответ/перезапуск/offline/смена профиля не теряют и не удваивают запись.
Finish/abort ждут ack, частичный итог сохраняет объём, старые aborted не становятся минутой.
Migration clean+upgrade+backfill; 300XPcap/dailytimezone/полночь/late events/streak tested.
typecheck, format:check, lint, npm test, build, backend:validate dry-run и браузерные сценарии.
Физическая точность/нагрев S23 требуют устройства и не объявляются доказанными headless.
