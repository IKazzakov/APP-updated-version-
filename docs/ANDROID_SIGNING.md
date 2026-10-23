# Постоянная подпись Android

Основной репозиторий — `rojoscarlos-cpu/APP-updated-version-`, ветка `main`, версия 2.5.4. Установленный совместимый пакет — **com.movement.squat.staging.ui**, название **Движение Тест UI**. Статус репозитория не меняет идентичность приложения Android.

Закреплённый сертификат SHA-256:

`122721cc9aa1600dca3ba86f4318f0e3c43c3c4b562a5c8d3114ea4194dfc0de`

Обновления должны сохранять пакет и закрытый ключ. Старые отдельные пакеты `com.movement.squat` и `com.movement.squat.staging` не обновляются этим APK и имеют другие профили.

## Где хранится ключ

- `android/staging-signing.json` содержит только пакет, название и открытый отпечаток сертификата.
- Локально используется `MOVEMENT_STAGING_KEYSTORE`, по умолчанию игнорируемый `work/signing/staging-debug.keystore`. Права файла — 600.
- В Actions этого репозитория нужен **STAGING_ANDROID_KEYSTORE_BASE64**. Наличие этого секрета в прежнем источнике не переносит его в новый репозиторий.
- [Зашифрованная резервная копия](../private-backups/README.md) включена в новый репозиторий. Пароль хранится у владельца отдельно. Незашифрованные keystore, Base64, пароль и исходный частный архив в git не добавляются.

В резервной копии: `staging-debug.keystore`, `STAGING_ANDROID_KEYSTORE_BASE64.txt`, открытый `staging-certificate.der` и инструкция. Alias — `androiddebugkey`, пароль самого debug-keystore — `android`; это не пароль AES-архива.

## Настроить Actions нового репозитория

1. Скачать [AES-256 архив](https://github.com/rojoscarlos-cpu/APP-updated-version-/raw/refs/heads/main/private-backups/Movement-Test-UI-signing-backup-AES256.zip), имея доступ к приватному репозиторию.
2. Распаковать в 7-Zip/WinRAR с паролем владельца. Сохранить отдельную резервную копию вне временной среды.
3. Открыть [APP-updated-version- → Settings → Secrets and variables → Actions](https://github.com/rojoscarlos-cpu/APP-updated-version-/settings/secrets/actions).
4. Нажать **New repository secret**, имя **STAGING_ANDROID_KEYSTORE_BASE64**, значение — всё содержимое подготовленного `STAGING_ANDROID_KEYSTORE_BASE64.txt`. В чат значение не отправлять.
5. После появления нового workflow в `main` запустить **Movement — checks and APK**, выбрать нужную ветку и `build_apk=true`. Убедиться, что сертификат APK совпал с закреплённым отпечатком.

GitHub не показывает значение уже сохранённого Actions secret. Для восстановления нужен исходный ключ/резервная копия; создание временного workflow для вывода секретов не используется.

## Локальная сборка

Восстановить файл в игнорируемый каталог, выставить права 600 и подготовить JDK/SDK:

```sh
source scripts/android-env.sh
export MOVEMENT_STAGING_KEYSTORE="$PWD/work/signing/staging-debug.keystore"
npm run build:apk
```

Сборка проверяет сертификат до изменения временной конфигурации и повторно после Gradle. Отсутствующий или чужой ключ останавливает выпуск; новый ключ автоматически не создаётся. Проверяются пакет, версия, права, локальные ML-ресурсы и отсутствие вложенного APK/закрытого ключа.

Actions восстанавливает ключ во временный файл 600, удаляет его после сборки и загружает только APK и открытые метаданные. Кэшируются зависимости Gradle, а не ключи. Workflow не записывает APK обратно в `main`.

## Проверка сохранённого выпуска

Текущие версия, размер и SHA-256 `public/app-debug.apk` находятся в соседнем `app-debug.apk.json`. Исторический выпуск 2.5.3 зафиксирован в [отчёте](releases/2.5.3-2026-10-23.md). Новые версии сохраняют тот же пакет и сертификат. Физическое обновление и сохранение профиля проверяются на телефоне.
