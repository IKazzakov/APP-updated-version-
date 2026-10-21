# Сторонние компоненты

- `@mediapipe/tasks-vision` 0.10.32 — Google LLC, Apache License 2.0. JS и соответствующие WASM берутся из одного закреплённого npm-пакета.
- MediaPipe Pose Landmarker Full и Lite (float16), Hand Landmarker (float16) — Google MediaPipe / Google AI Edge. Модели распространяются под Apache License 2.0. Модельные карточки: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker#models и https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker#models .
- Vite, esbuild — MIT; транзитивные лицензии содержатся в устанавливаемых npm-пакетах.

Файлы моделей взяты из закреплённых коммитов публичных зеркал, поскольку официальный storage.googleapis.com ограничен сетевой политикой среды разработки. Приложение читает исключительно локальные копии; зеркала при работе не используются. Источники, размеры и SHA-256 записаны в `public/assets/models/manifest.json`. Проверены ZIP/CRC, сигнатуры TFLite и запуск каждой модели в Chromium. Full из двух независимых зеркал побайтно совпадает; хеш этой копии `4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad`. Это не утверждение о сверке с недоступным официальным сервером.

Текст Apache License 2.0: `LICENSE-APACHE-2.0.txt`.

- `tests/fixtures/hands.jpg` — публичная тестовая фотография из tensorflow/tfjs-models, `hand-pose-detection/test_data/hands.jpg` (Apache 2.0). Используется только в проверках, не включается в приложение. `hand-landmarks.json` — числовой результат Hand Landmarker на этой фотографии, без данных камеры пользователя.
