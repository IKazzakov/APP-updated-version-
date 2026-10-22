# Резервная копия ключа «Движение Тест UI»

[Скачать зашифрованный ZIP](https://github.com/rojoscarlos-cpu/Test/raw/refs/heads/codex/server-optimization/private-backups/Movement-Test-UI-signing-backup-AES256.zip).
Для доступа войти в GitHub аккаунтом с доступом к закрытому репозиторию Test.

Архив зашифрован AES-256. Пароль передан владельцу в чате и не хранится в репозитории.
Распаковка: 7-Zip, WinRAR или другой архиватор с поддержкой ZIP AES-256.
Проверены расшифровка всех файлов и отказ при неверном пароле.

Внутри: постоянный staging-debug.keystore, готовый STAGING_ANDROID_KEYSTORE_BASE64.txt,
открытый сертификат и инструкция. Файл Base64 предназначен для одноимённого GitHub
Actions secret. Скачанную резервную копию сохранить у владельца.

Пакет: com.movement.squat.staging.ui. Сертификат SHA-256:
122721cc9aa1600dca3ba86f4318f0e3c43c3c4b562a5c8d3114ea4194dfc0de.

Архив находится вне public и Android assets и не распространяется с приложением.
Незашифрованные ключ, Base64 и пароль архива не добавлять в git.
