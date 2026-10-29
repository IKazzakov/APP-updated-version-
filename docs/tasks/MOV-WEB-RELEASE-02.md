# MOV-WEB-RELEASE-02 — устранить отказ PUBLIC_HTML

## Роль и одна цель

Исполнитель: Backend / инфраструктура «Движения», новый тред.
Репозиторий: https://github.com/rojoscarlos-cpu/APP-updated-version-.
Base/main: **952da1e0e4753309e7fcfe51f42fefbb66a1b010**, tree **b308d9301b84bd087fc6435065f38a79040d1053**.
Версия main: **2.6.1** по package.json и src/config.js.
Рабочая ветка: **codex/mov-web-release-public-get-20261029**, target **main**, draft PR.
Сохранить исходный коммит постановки; сначала проверить main/HEAD/status.
Чужую работу не сбрасывать. Внутренние подагенты **не разрешены**.

Одна цель: установить и устранить причину отказа чтения опубликованного HTML
в release prepare. Это контрольная точка1 «полный браузер + основной API»,
не новая функциональная доработка. Успех unit с fake transport не закрывает
фактический отказ GitHub runner.

## Обязательные источники

Инструкции PR24 ещё не находятся в main; применять указанную ревизию:
- [AGENTS](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/AGENTS.md)
- [TEAM_CONTEXT](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/TEAM_CONTEXT.md)
- [Backend](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/team/BACKEND.md)
- [шаблон задачи](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/team/TASK_TEMPLATE.md).

На base:
- [API](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/docs/API.md)
- [разработка](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/docs/DEVELOPMENT.md)
- [единственный сервер](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/docs/SINGLE_SERVER.md)
- [передача результатов](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/docs/team/HANDOFF.md)
- [release script](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/scripts/release-web-api.mjs)
- [release tests](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/tests/web-api-release.test.js)
- [release workflow](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/.github/workflows/release-web-api.yml)
- [конфигурация Worker](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/wrangler.backend.json)
- [отчёт и порядок выпуска](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/docs/releases/MOV-WEB-RELEASE-01.md)
- [предыдущая задача](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/952da1e0e4753309e7fcfe51f42fefbb66a1b010/docs/tasks/MOV-WEB-RELEASE-01-NET.md).

Читать целевым образом эти файлы и прямые зависимости. Не проводить аудит
всего сервера/клиента. wire-типы/валидаторы, SQL, Android и алгоритмы read-only.

## Доказательство отказа

[Run40904842514](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40904842514),
workflow_dispatch, main/source **952da1e0e4753309e7fcfe51f42fefbb66a1b010**, attempt1:
- job123556675127: build PASS, release unit PASS
  (release guards + 63 staged fixtures), настоящий prepare FAILURE;
- log: `Remote GET failed: {"stage":"PUBLIC_HTML","errorType":"TypeError"}`;
- error upload SUCCESS, deploy job123557078913 SKIPPED;
- [artifact12911366141](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40904842514/artifacts/12911366141)
  скачан Тимлидом: 233 bytes, ZIP SHA256
  `377675ecc90520e7d34bca615c365c46576d277d2b918cad9ac9eb923f8cd154`;
- единственный error.json:
  `{"schema":1,"status":"FAILED","diagnostic":{"stage":"PUBLIC_HTML","errorType":"TypeError"}}`.

HTTP status/causeCode отсутствуют. Установлен этап, но не корневая причина.
Не объявлять неверный Cloudflare token, отсутствие Worker/D1, CORS или
ошибку телефона на основании этого JSON. PASS других remote этапов и полный
remote.status=PASS этим артефактом не доказаны.

## Работа и проверяемый результат

1. На GitHub runner, до merge, воспроизвести именно публичный GET к
   `https://movement-test-api-staging.rojoscarlos93.workers.dev/`:
   тот же Node24, флаг --use-env-proxy и фактические request options release
   пути. Отдельно сравнить с минимальным корректным GET в той же среде.
   Не выводить headers/options целиком; фиксировать только безопасные признаки.
2. Добавить ограниченную проверку публичного чтения в PR workflow
   (.github/workflows/release-web-api.yml, отдельный job без secrets).
   Он не вызывает весь prepare, Cloudflare control plane или бизнес-операции.
   Его можно запустить штатным PR CI без нового main merge и без credentials.
   Использовать фиксированный адрес, GET, ограниченный timeout, без retries.
   Успех HTTP-ответа отделить от проверки 2xx/содержимого release.
   Никаких произвольных URL из input и автоматических переходов на иной host.
3. Различить ошибку создания запроса, request exception и body consumption.
   Если cause вложен в AggregateError.errors, извлекать только закрытые
   разрешённые типы/коды, с ограничением глубины/количества и защитой от циклов.
   Нельзя копировать raw message/stack/error/cause, URL, IP, headers, body,
   env, IDs, secrets или settings в лог/artifact.
   Неизвестный код оставить UNKNOWN; добавить фиксированную классификацию
   только по установленной причине, не выдавать динамическую строку за safe.
4. После доказательства причины — минимальная правка GET пути в
   scripts/release-web-api.mjs и регрессия, воспроизводящая реальный дефект.
   Если причина внешняя/нужны иные файлы или настройки — вернуть точный факт,
   безопасное evidence и требуемое изменение Тимлиду; доступы не менять.
5. Вернуть проверку того же реального публичного GET на исправленном source,
   а не только искусственный fixture. Не повторять весь remote prepare ради
   диагностики этого GET. Полный remote prepare после review/разрешённого
   merge остаётся отдельным контрольным действием Тимлида.

## Контракт и сохраняемые границы

HTTP API приложения, auth/Bearer/Origin/CORS, wire JSON, идемпотентность UUID,
пагинация, ревизии и совместимость v1/v2 **не меняются**.
Общие api.ts/validate.ts не редактируются; нового владельца для них не требуется.

Диагностическая проверка принимает только фиксированную конфигурацию публичного
GET; результат — PASS либо безопасная фаза/категория/известный causeCode и
фактически полученный status. Ошибка — nonzero, не PREPARED/remote.status=PASS.
Реальный production request не подменяется fixture. Не пропускать проверки
HTML/APK checksum, Worker bindings/D1, прежней версии и release guards.

Не отключать TLS, штатный proxy, IPv6 или сетевую политику по догадке.
Не ослаблять auth/Origin, не направлять трафик на второй сервер.
Блок jobs.deploy, validateLocal/uploadForm/publishVersion/deploy и условия
main/SHA/confirmation не расширять. Публичный probe не получает CF secrets.
Не передавать Cloudflare Authorization в запрос публичной страницы.

## Точные границы файлов

Редактирование:
- scripts/release-web-api.mjs — только доказанный дефект GET/безопасная причина;
- tests/web-api-release.test.js — адресная регрессия и санитизация;
- tests/web-api-public-read.mjs — новый небольшой live GET probe без секретов;
- .github/workflows/release-web-api.yml — только отдельный PR public-read job,
  без изменения deploy, существующих secrets и permissions;
- docs/releases/MOV-WEB-RELEASE-01.md — доказательство причины/исправления/ограничений.

docs/tasks/MOV-WEB-RELEASE-02.md — постановка Тимлида, сохранять.
Остальные файлы read-only, существенное расширение согласовать с Тимлидом.
Worker/SQL/assets/версии/Frontend/Android/исходный Test не менять.

## Проверки и приёмка

- Холодный `node tests/web-api-release.test.js` без dist/client; прежние
  отрицательные guards и 63 fixtures, новая регрессия причины, bounded
  AggregateError/cycle/marker-secret sanitation по затронутому изменению.
- Syntax, адресные format/YAML/diff; Worker dry-run при изменённой упаковке.
  Не заменять настоящий prepare fake builder в рабочем CLI.
- Реальный public GET probe в GitHub PR run с source SHA и безопасным выводом;
  отразить PASS либо конкретный BLOCKED и не скрывать nonzero.
- Штатный обязательный CI. Полный ручной набор/browser/APK не дублировать.
  Probe не доказывает работу камеры/телефона и полный remote readiness.
- Если ошибка внешняя, конечный результат — доказанная причина и точный
  внешний блокер. Просто повтор прежнего PUBLIC_HTML/TypeError не завершает задачу.

## Передача и порядок интеграции

Вернуть ветку/draft PR/source SHA, diff файлов, причину и evidence до/после,
ссылку на PR probe run, адресные проверки и NOT_RUN. Отчёт доступен из репозитория.
Тимлид принимает изменение, затем отдельно согласует main merge и read-only
remote prepare. Публикация Worker требует отдельной команды владельца после
remote.status=PASS. Эта задача **не разрешает merge/deploy/миграции**,
live guest/profile/результаты/XP, APK или изменения инфраструктуры.
