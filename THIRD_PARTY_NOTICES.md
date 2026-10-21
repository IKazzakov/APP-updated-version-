# Сторонние компоненты

- `@mediapipe/tasks-vision` **0.10.32** — Google LLC, Apache License 2.0. JS и соответствующие WASM берутся из одного закреплённого npm-пакета.
- **MediaPipe Pose Landmarker Full (float16)** — Google MediaPipe / Google AI Edge, Apache License 2.0. Карточка модели: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker#models .
- Vite, esbuild и `@openai/sites-vite-plugin` — MIT; Wrangler, Cloudflare Vite Plugin и их транзитивные компоненты — лицензии соответствующих закреплённых npm-пакетов. Полные тексты доступны в `node_modules` после установки.

Модель взята из закреплённого коммита публичного зеркала, поскольку официальный `storage.googleapis.com` ограничен сетевой политикой среды разработки. Приложение читает только размещённую с ним копию; зеркало во время работы не используется. Источник, размер и SHA-256 записаны в `public/assets/models/manifest.json`; хеш проверяется при сборке. Сохранённая Full-модель из двух независимых зеркал ранее побайтно совпала; SHA-256: `4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad`. Это не утверждение о сверке с недоступным официальным сервером.

Текст Apache License 2.0: `LICENSE-APACHE-2.0.txt`.

В MVP удалены Hand Landmarker, Pose Lite и прежняя фотография кистей для тестов.
