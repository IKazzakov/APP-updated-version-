# Резервная копия постоянного Android-ключа

[Скачать зашифрованный ZIP](https://github.com/rojoscarlos-cpu/APP-updated-version-/raw/refs/heads/main/private-backups/Movement-Test-UI-signing-backup-AES256.zip).
Нужен доступ к приватному основному репозиторию `APP-updated-version-`.

Архив зашифрован AES-256. Пароль находится у владельца отдельно от репозитория. Распаковка: 7-Zip, WinRAR или другой архиватор с поддержкой ZIP AES-256.

Внутри: постоянный `staging-debug.keystore`, готовый `STAGING_ANDROID_KEYSTORE_BASE64.txt`, открытый сертификат и инструкция. Base64 предназначен для одноимённого repository secret нового репозитория. GitHub не переносит secrets вместе с исходниками и не выдаёт их значения для чтения.

Пакет: `com.movement.squat.staging.ui`. Сертификат SHA-256:

`122721cc9aa1600dca3ba86f4318f0e3c43c3c4b562a5c8d3114ea4194dfc0de`.

Архив расположен вне `public` и Android assets. Незашифрованные ключ, Base64 и пароль в git, журнал или клиент не добавлять. Сохранить резервную копию у владельца вне временной среды. [Настройка и сборка](../docs/ANDROID_SIGNING.md).
