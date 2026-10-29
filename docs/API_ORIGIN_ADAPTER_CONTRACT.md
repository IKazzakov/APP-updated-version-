# Внутреннее подтверждение Origin — MOV-WEB-API-01

Решение Тимлида · 29 октября 2026 года. Дополнение к
[внешнему HTTP/CORS-контракту](WEB_APP_CONTRACT.md).
HTTP, JSON, auth, URL клиента и требования Frontend не изменяются.
Это инструкция реализации, не объявление готового кода и не разрешение выпуска.

## Основание и граница

Backend сообщил воспроизводимый на отдельной SQLite отказ POST profile:
Cloudflare допускает доверенный Pages Origin, затем business handleApi
повторно возвращает403 ORIGIN_FORBIDDEN. Эксперимент не публиковался и удалён.
Это результат Backend, а не повторный тест Тимлида.

Проверенные публичные интерфейсы main
`6733f9703a2588dd2978bdd5059fc763f943bb28` /2.6.1:
- `handleApi(request, env, options={})`; существующий options.now сохраняется.
- Cloudflare передаёт `handleApi(new Request(request,{headers}), env)`.
- Sites worker передаёт `handleApi(request, env)`; Node использует этот адаптер.

Прежний запрет править server/api.js уточняется: допускается только внутренний
options.originApproval и условие Origin gate. Бизнес-маршруты/SQL не переписывать.

## Один способ передачи

Модуль `server/browser-origin.js` владеет проверкой точного Pages Origin
по WEB_APP_CONTRACT и приватной WeakMap с подтверждениями.
Предлагаемые новые публичные функции этого внутреннего модуля:

```js
approveBrowserOrigin(request) // Request -> frozen opaque object | null
isBrowserOriginApproved(request, approval) // Request, unknown -> boolean
```

Это новые внутренние интерфейсы для реализации; в текущей main их ещё нет.

1. approveBrowserOrigin проверяет фактический Origin исходя из закреплённой
   политики movement-preview. Только разрешённый Pages Origin создаёт новый
   непрозрачный frozen object; остальные входы дают null.
2. В приватной WeakMap ключом служит сам object-подтверждение, значением —
   точный Request и snapshot его method, url и Origin. Map не экспортируется;
   подтверждение не содержит доступных/сериализуемых свойств допуска.
3. isBrowserOriginApproved безопасно принимает unknown и проверяет наличие
   этого object в приватной Map, identity Request и неизменность snapshot.
   Копия/десериализация/поддельный object/boolean/string/null — false.
   Другой Request, включая clone и запрос другого маршрута/метода, — false.
   Изменённый Origin того же Request — false. Подтверждение не кешировать
   по hostname/userId и не переносить на следующий HTTP-запрос.
4. Cloudflare сначала выполняет свой Origin/preflight и прежнюю
   Bearer-аутентификацию. Создаёт **окончательный Request**, который фактически
   пойдёт в handleApi после штатного wrapping headers. Затем получает proof
   именно для этого объекта и вызывает:
   `handleApi(apiRequest, env, {originApproval})`.
   Прежний Origin не переписывается и не удаляется.
5. handleApi в существующем POST Origin guard допускает **старое условие ИЛИ
   валидный proof** из options.originApproval. При отсутствии/невалидном proof
   действует ровно прежняя проверка. Невалидный proof не ломает законный
   same-origin запрос и не разрешает запрещённый.
6. Proof подтверждает только транспортный Origin. Он не задаёт пользователя,
   не подтверждает Bearer/профиль и не отменяет body/JSON/ownership/rate/time/
   UUID/SQL проверки. options.now и все старые вызовы работают по-прежнему.
7. Sites и Node не передают новое option: их допуск Origin не расширяется.
   Публичный browser не отправляет proof — такой HTTP-параметр отсутствует.

Недопустимо: options.skipOriginCheck/boolean trust flag, X-*-заголовок допуска,
значение proof из тела/query/headers, Symbol.for/строковая метка вместо приватной
проверки identity, подмена Origin на URL API, удаление business Origin guard,
включение Pages origin глобально для всех адаптеров.

OPTIONS остаётся без Bearer/D1/бизнес-мутаций; CORS wrapping и ошибка403
ORIGIN_FORBIDDEN остаются по внешнему контракту.
Wire api.ts/validate.ts, схема D1, версия, роли Frontend и основной API-base
не меняются. Никакой дополнительный backend/прокси не создаётся.

## Обязательная проверка на границе адаптеров

На отдельной локальной SQLite и настоящих обработчиках:
- Cloudflare OPTIONS → guest → profile с доверенного Pages Origin:
  успешный profile, прежний JSON и CORS, Bearer/владелец остаются настоящими.
- Повтор profile/бизнес-записи сохраняет прежнюю идемпотентность.
- Прямой handleApi с тем же Pages Origin без proof, с options.now или с
  поддельным proof:403 и нет записи; реальный proof от другого Request тоже403.
- Прямой handleApi/через Sites и Node с прежним same-origin сохраняют поведение;
  без явно переданного валидного proof Pages Origin там не допускается.
- Header/body/query с именами internal approval/skipOriginCheck не дают допуск.
- Даже валидный Origin proof не даёт чужой userId/Bearer, не принимает неизвестные
  body-поля, не превращает missing profile/session в успех.
- Мутация Origin, clone, смена пути/метода, сериализованная копия proof —
  отдельные отрицательные случаи. Пустой/чужой Origin не выдаёт proof.
- Прежние cloudflare.test.js и default options.now сценарии проходят.

Новые адресные тесты в tests/api-origin-context.test.js, плюс browser-origin.test.js
и существующий cloudflare.test.js. Полный ручной набор/APK повторно не нужен.
Backend dry-run один раз после окончательных импортов; обязательный CI сохраняется.

## Передача и совместная работа

Продолжить существующие ветку/PR30 и тред MOV-WEB-API-01.
В отчёте показать реальное прохождение profile в цепочке Cloudflare→handleApi,
отказы остальных адаптеров, файлы/SHA/адресные проверки и NOT_DEPLOYED.
Не возвращать только preflight/health как готовность бизнес-операций.

Frontend продолжает MOV-WEB-APP-01: CORS-входы/выходы/API URL не изменились.
Его рабочую ветку ради этого внутреннего дополнения не переписывать.
Тимлид при интеграции сохраняет это дополнение вместе с обновлением API.md.
Main merge/deploy/remote D1 по-прежнему требуют команды владельца после готового PR.
