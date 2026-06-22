# Система онлайн-записи — Дарья Лукьянова

Запись на занятия (вокал · фортепиано · сольфеджио): форма заявки для сайта
Wfolio + админка-PWA для iPhone/iPad + уведомления в Telegram и push.

## Состав

| Файл | Что это | Куда деплоится |
|------|---------|----------------|
| `index.html` | Админка-PWA (вход, заявки, календарь, push) | GitHub Pages |
| `manifest.json` | Манифест PWA | GitHub Pages |
| `service-worker.js` | Офлайн-кэш оболочки (**в корне**) | GitHub Pages |
| `firebase-messaging-sw.js` | Фоновые push FCM (**в корне**) | GitHub Pages |
| `icons/` | Иконки PWA: `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | GitHub Pages |
| `Code.gs` | Apps Script: Telegram + push | Google Apps Script (Web App) |
| `firestore.rules` | Правила безопасности Firestore | Firebase Console |
| `seed-packages.js` | Заполнение коллекции `packages` | запуск локально |

> Форма заявки (HTML-блок) живёт **не в репозитории**, а вставлена напрямую в
> HTML-блок на странице Wfolio.

> ⚠️ Service worker'ы **обязаны лежать в корне** репозитория (рядом с `index.html`),
> иначе scope PWA и фоновые push не работают.

## Плейсхолдеры (заменить перед деплоем)

- `FIREBASE_CONFIG` — в `index.html`, `firebase-messaging-sw.js` и в HTML-блоке формы на Wfolio
- `VAPID_KEY` — в `index.html`
- `APPSCRIPT_URL` — в HTML-блоке формы на Wfolio

Секреты (`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `SERVICE_ACCOUNT`, `FIREBASE_PROJECT_ID`)
хранятся **только** в Script Properties Apps Script — в HTML их нет.

---

## 1. Firebase

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Build → Authentication → Get started → Email/Password** → включить.
   Затем **Users → Add user**: email и пароль Даши (это и есть вход в админку).
3. **Build → Firestore Database → Create database** (production mode, регион
   `eur3`/`europe-west`).
4. **Project settings → General → Your apps → Web (`</>`)** → зарегистрировать
   приложение → скопировать объект `firebaseConfig` и вставить в `index.html`,
   `firebase-messaging-sw.js` и в HTML-блок формы на Wfolio.
5. **Cloud Messaging → Web configuration → Generate key pair** → скопировать
   ключ в `VAPID_KEY` (`index.html`).
6. **Firestore → Rules** → вставить содержимое `firestore.rules` → **Publish**.

### Стартовые данные — пакеты (`packages`)

Форма показывает активные пакеты из коллекции `packages`. Пакеты привязаны
к направлениям через поле `directions` (массив): индивидуальные показываются
для вокала/фортепиано/сольфеджио, групповые — каждый для своего направления
(групповой вокал / хор / мастер-класс). Если поле `directions` отсутствует —
пакет показывается для всех направлений.

**Способ 1 — seed-скрипт (рекомендуется):**

```bash
npm install firebase-admin
# положите рядом ключ сервис-аккаунта как service-account.json
node seed-packages.js
```

Зальёт все пакеты разом, повторный запуск безопасно перезапишет их.
`service-account.json` уже в `.gitignore` — не коммитьте его.

**Способ 2 — вручную** в консоли Firestore, по документу на пакет
(поля и типы): `title`(string), `price`(number), `lessonsCount`(number),
`description`(string), `active`(boolean=true).

Актуальный набор:

| title | description | price | lessonsCount | directions |
|-------|-------------|------:|:---:|---|
| Пробное занятие | 50 минут · знакомство | 2 000 | 1 | инд. |
| Разовое занятие | 50 минут | 2 800 | 1 | инд. |
| Разовое занятие | 1 час 15 минут | 4 200 | 1 | инд. |
| Разовое занятие | 1 час 40 минут | 5 200 | 1 | инд. |
| Абонемент · 4 занятия | по 50 минут · 1 месяц | 10 400 | 4 | инд. |
| Абонемент · 8 занятий | по 50 минут · 2 месяца | 20 000 | 8 | инд. |
| Абонемент · 4 занятия | по 1 ч 15 мин · 1 месяц | 16 000 | 4 | инд. |
| Абонемент · 8 занятий | по 1 ч 15 мин · 2 месяца | 31 200 | 8 | инд. |
| Групповой вокал | 50 минут · с участника | 2 000 | 1 | групповой вокал |
| Групповой вокал | 1 час 40 минут · с участника | 3 500 | 1 | групповой вокал |
| Хор · разовое | 1 час 50 минут | 2 000 | 1 | хор |
| Хор · абонемент 4 занятия | действует 30 дней | 7 400 | 4 | хор |
| Мастер-класс | 1 час 40 минут · с участника | 3 500 | 1 | мастер-класс |

> «инд.» = `["вокал","фортепиано","сольфеджио"]`. Цена групповых — **с участника**.

Слоты (`slots`) Даша добавляет сама во вкладке «Календарь» админки.
Коллекции `bookings` и `config/admin` создаются автоматически.

---

## 2. Telegram-бот

1. В Telegram напишите [@BotFather](https://t.me/BotFather) → `/newbot` →
   получите **TELEGRAM_TOKEN**.
2. Напишите своему боту любое сообщение, затем откройте
   `https://api.telegram.org/bot<TOKEN>/getUpdates` и найдите
   `chat.id` — это **TELEGRAM_CHAT_ID**.

---

## 3. Apps Script (уведомления)

1. [script.google.com](https://script.google.com) → **New project** → вставьте
   содержимое `Code.gs`.
2. **Project Settings → Script Properties** → добавьте:
   - `TELEGRAM_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `FIREBASE_PROJECT_ID` *(для push; можно пропустить)*
   - `SERVICE_ACCOUNT` — весь JSON ключа сервис-аккаунта одной строкой
     (Firebase → **Project settings → Service accounts → Generate new private key**).
3. **Deploy → New deployment → Web app**: *Execute as* — **Me**,
   *Who has access* — **Anyone** → скопируйте URL в `APPSCRIPT_URL`
   (HTML-блок формы на Wfolio).

> Push в PWA — опционально. Без `SERVICE_ACCOUNT`/`FIREBASE_PROJECT_ID`
> работает только Telegram-уведомление.

---

## 4. GitHub Pages (админка-PWA)

1. Запушьте файлы в репозиторий (ветка `main`).
2. **Settings → Pages → Build and deployment**:
   - *Source* — **Deploy from a branch**
   - *Branch* — **main** / **/ (root)** → **Save**.
3. Через минуту админка будет доступна по адресу
   `https://<username>.github.io/<repo>/`.

### Добавить домен Pages в Firebase

**Firebase Console → Authentication → Settings → Authorized domains → Add domain**
→ добавьте `<username>.github.io`. Без этого вход по email/паролю в PWA
работать не будет.

---

## 5. Форма на Wfolio

Код формы вставлен HTML-блоком прямо на нужную страницу Wfolio (в репозитории
он не хранится). В нём заполнены `FIREBASE_CONFIG` и `APPSCRIPT_URL`. Стили
изолированы под класс `.cvh-booking` и не конфликтуют с темой сайта.

---

## 6. Установка PWA на iOS

> Только **iOS/iPadOS 16.4+**. Web push на iOS работает **исключительно из
> установленной на рабочий стол PWA** — не из Safari.

1. Откройте адрес GitHub Pages в **Safari**.
2. Кнопка «Поделиться» → **На экран «Домой»** → **Добавить**.
3. Запустите приложение с рабочего стола, войдите по email/паролю.
4. Нажмите **«Включить»** в баннере уведомлений и разрешите их —
   токен устройства сохранится в `config/admin`, и при новой заявке
   придёт push.

---

## Модель данных Firestore

```
slots/{id}      date, time, durationMin, direction, status(free|booked), createdAt
packages/{id}   title, price, lessonsCount, description, active
bookings/{id}   slotId, packageId, direction, name, phone, telegram, comment,
                status(pending|confirmed|cancelled), slotDate, slotTime,
                packageTitle, packagePrice, createdAt
config/admin    fcmTokens(array)
```

При подтверждении заявки слот → `booked`, при отмене → `free`.
