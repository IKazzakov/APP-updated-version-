# План: Сборка Android APK через Capacitor для Samsung Galaxy S23

Цель: настроить проект Capacitor для генерации установочного файла `app-debug.apk`, настроить разрешения камеры, привязать сетевые запросы к публичному серверу и скомпилировать APK, которым можно поделиться с друзьями.

---

## 1. Установка и настройка Capacitor
- Установить пакеты:
  - `@capacitor/core`
  - `@capacitor/cli`
  - `@capacitor/android`
- Создать файл конфигурации `capacitor.config.json`:
  - `appId`: `com.movement.squat`
  - `appName`: `Движение`
  - `webDir`: `dist/client`
  - Настройка сетевого доступа: разрешить смешанный контент и HTTPS-запросы к публичному серверу приложения.

---

## 2. Привязка API к публичному серверу в APK
- **Контекст:** В веб-браузере запросы идут по относительному пути `/api/...` к текущему origin. Внутри нативного APK веб-ресурсы загружаются по локальному протоколу `http://localhost` или `https://localhost`.
- **Решение:**
  - В `src/api.js` добавить определение среды: если приложение запущено внутри Capacitor/Android, базовый URL API автоматически переключается на публичный HTTPS-адрес сервера (`https://ais-pre-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app` или домен по умолчанию), сохраняя передачу сессий и заголовков.

---

## 3. Генерация нативного Android-проекта
- Выполнить `npx cap add android` для генерации структуры каталога `android/`.
- Настроить `android/app/src/main/AndroidManifest.xml`:
  - `<uses-permission android:name="android.permission.CAMERA" />`
  - `<uses-permission android:name="android.permission.INTERNET" />`
  - `<uses-permission android:name="android.permission.WAKE_LOCK" />`
  - `<uses-feature android:name="android.hardware.camera" android:required="true" />`
  - `<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />`
  - Зафиксировать портретную ориентацию `android:screenOrientation="portrait"`.
  - Установить красивую иконку приложения на основе существующего `public/icon.svg`.

---

## 4. Сборка готового APK (`app-debug.apk`)
- Создать скрипт в `package.json`: `"build:apk": "npm run build && npx cap sync android && cd android && ./gradlew assembleDebug"`.
- Запустить сборку `gradlew assembleDebug`.
- Скопировать полученный файл `app-debug.apk` в корневую папку/директорию раздачи, чтобы вы могли моментально скачать его и отправить друзьям.

---

## 5. Обновление версии
- Обновить версию приложения с **2.4.0** до **2.5.0** (добавление нативной Android платформы и Capacitor APK).
