# MOV-WEB-RELEASE-01-NET — причина отказа remote prepare

## Роль и один результат

Backend/инфраструктура «Движения». Одна цель: установить точный этап/причину
сетевого отказа read-only prepare и устранить подтверждённый дефект в разрешённых
границах. Выпуск/изменение Cloudflare не разрешены.
Это продолжение контрольной точки1 (работающий браузер/API), не новый продуктовый этап.

Repo https://github.com/rojoscarlos-cpu/APP-updated-version-.
Main/base **50bab63c34ad95e795f9508a33307b93af0c9eb3**, версия2.6.1.
Ветка **codex/mov-web-release-network-20261029**, target **main**.
Исходный коммит постановки сохранять; перед работой проверить main/HEAD/status.
Не сбрасывать чужие изменения. Внутренние подагенты не разрешены.

Прочитать pinned инструкции PR24:
[AGENTS](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/AGENTS.md),
[TEAM_CONTEXT](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/TEAM_CONTEXT.md),
[Backend](https://github.com/rojoscarlos-cpu/APP-updated-version-/blob/4b1d0b8fa8b19ff8ee4e3aa8a90a349664cc4471/docs/team/BACKEND.md).
В базе прочитать docs/tasks/MOV-WEB-RELEASE-01.md,
docs/releases/MOV-WEB-RELEASE-01.md, API.md, SINGLE_SERVER.md и DEVELOPMENT.md.
Целевое чтение scripts/release-web-api.mjs, tests/web-api-release.test.js,
.github/workflows/release-web-api.yml и используемые прямые зависимости.
HTTP/wire/SQL/Android/распознавание read-only.

## Доказанные факты

PR32 и30 слиты владельцем разрешённой последовательностью; main содержит
проверенный код ffd4df6 без дополнительных изменений дерева.
[Ручной prepare40893762949](https://github.com/rojoscarlos-cpu/APP-updated-version-/actions/runs/40893762949),
оба attempt: build/unit PASS, шаг prepare падает **fetch failed**, artifact upload
SKIPPED, deploy SKIPPED. Последний job123518390398.
В env job Cloudflare bindings присутствуют (значения скрыты).
Лог не показывает стадию, адрес запроса или cause.code.
Это не доказательство неверного токена, отсутствия Worker либо ошибки D1.
Повторять весь workflow без новой диагностики не нужно.

## Изменение и контракт

В remote GET-пути добавить закрытые безопасные метки этапов: например
CF_SUBDOMAIN, CF_DATABASES, CF_DEPLOYMENTS, CF_VERSION, CF_SETTINGS,
PUBLIC_HTML/PUBLIC_APK_METADATA/PUBLIC_APK_CHECKSUM — согласно фактическим запросам.
При отказе сохранять stage, тип ошибки, допустимый cause.code и HTTP status,
если response получен. Для network exception не выдумывать HTTP status.
При необходимости показывать только HTTPS hostname; без account/database IDs,
полного URL/path/query, Authorization, token, response bodies и raw message/stack
с приватными значениями. Не выводить settings/vars.

Писать безопасный диагностический JSON при ошибке и сохранять его в приватный
artifact даже при неуспешном prepare. Отсутствующий manifest не считать PASS.
После установления причины — минимально исправить подтверждённый сетевой/
request дефект. Если причина внешняя или нужны другие файлы/права — вернуть
факт и точное требование Тимлиду; не менять доступы/Origin/policy самостоятельно.

Не отключать TLS verification, штатный proxy, проверки Worker/DB/assets и
не заменять ошибку успехом. Не внедрять слепые повторы POST/PUT/activation.
Если нужны retries, только ограниченные идемпотентные GET по установленной
transient причине, с timeout и проверкой unit.
Все прежние prepare/deploy/verify contracts и confirmation/SHA/main guards
сохраняются; HTTP API приложения/JSON/auth/идемпотентность не меняются.

## Точные файлы

- scripts/release-web-api.mjs — только GET error context/подтверждённое исправление.
- tests/web-api-release.test.js — адресные network/санитизация fixtures.
- .github/workflows/release-web-api.yml — только сохранение безопасного error artifact;
  режимы, условия deploy и источники secrets не расширять.
- docs/releases/MOV-WEB-RELEASE-01.md — факты причины/проверок/ограничений.

Другие файлы read-only. Не менять business API, SQL, APK, assets, версии,
Frontend branch и существующий основной deploy.yml.

## Приёмка и передача

1. Fake transport точно показывает этап отказа; marker-secret в URL/message/
   cause/headers не попадает в вывод или artifact. HTTP403 отличается от
   DNS/TLS/timeout/reset. Сохраняются прежние отрицательные release guard tests.
2. Холодный node tests/web-api-release.test.js без dist/client проходит;
   реальный prepare сохраняет настоящий dry-run.
3. Syntax/format/YAML/diff и адресный unit, обязательный CI; без ручного
   повторения полного набора/APK. Не вызывать live guest/profile/SQL.
4. Вернуть PR/source SHA, безопасную диагностику причины, команды и NOT_RUN.
   remote.status=PASS не заявлять, пока не проверены реальные настройки.
5. Исправление сначала проходит review. Новое слияние main требует команды
   владельца; прежнее разрешение PR32/30 на новый PR не распространяется.
   Авторизация deploy по-прежнему не дана.

Текущие Worker/D1/статика/APK остаются прежними. Дальнейшая живая проверка
только prepare после отдельно разрешённого слияния; затем отдельное deploy approval.
