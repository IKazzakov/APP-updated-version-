# Счётчик упражнений для Android

Приложение полностью адаптировано под Android и может использоваться двумя способами:
1. **Установка напрямую из браузера (PWA / WebAPK)** — самый быстрый способ (1 клик).
2. **Сборка в автономный APK / AAB пакет** — для распространения файла `.apk` или публикации в Google Play Store.

---

## Вариант 1. Установка в 1 клик на телефон (PWA / WebAPK)

Приложение поддерживает стандарт WebAPK и устанавливается как полноценное Android-приложение:
- Полноэкранный режим без адресной строки браузера (`standalone`).
- Иконка приложения на рабочем столе и в списке приложений Android (поддерживаются адаптивные / maskable иконки).
- Screen Wake Lock: экран телефона не гаснет во время тренировки.
- Локальная обработка: модели нейросети и WASM кэшируются через Service Worker, работают без задержек.

### Как установить:
1. Откройте приложение в Chrome на Android.
2. Вверху страницы появится кнопка **«Установить»** (или выберите в меню Chrome три точки `⋮` → **«Установить приложение»** / **«Добавить на главный экран»**).
3. Приложение появится в списке ваших Android-приложений и будет запускаться как нативное.

---

## Вариант 2. Сборка APK с помощью Bubblewrap (Google TWA — официальный инструмент Google)

Google TWA (Trusted Web Activity) оборачивает PWA в стандартный Android APK с минимальным размером (~2 МБ) и доступом к аппаратному WebGL/GPU:

```bash
# 1. Установите Bubblewrap CLI
npm install -g @bubblewrap/cli

# 2. Инициализируйте проект Android по URL вашего приложения
bubblewrap init --manifest=https://<ВАШ_URL>/manifest.webmanifest

# 3. Соберите APK
bubblewrap build
```

В результате будет сгенерирован готовый `app-release-signed.apk`, который можно установить на любое Android-устройство (`adb install app-release-signed.apk`) или загрузить в Google Play Console.

---

## Вариант 3. Сборка через Capacitor (нативный Android Studio проект)

Если требуется полноценный нативный проект с Android Studio:

```bash
# 1. Установите Capacitor
npm install @capacitor/core @capacitor/cli @capacitor/android

# 2. Инициализируйте проект
npx cap init "Счётчик упражнений" "com.exercisecounter.app" --web-dir dist

# 3. Добавьте платформу Android
npm run build
npx cap add android

# 4. Откройте проект в Android Studio для сборки APK
npx cap open android
```

В Android Studio выберите: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
