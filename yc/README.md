# Миграция на Yandex Cloud

Перенос системы записи с Firebase на Яндекс Облако (152-ФЗ: хранение
персональных данных в РФ). Каталог Даши: `b1g5f3ibgkjuf25m2vp9`.

## Архитектура

```
Форма (Wfolio) ─┐
                ├─→ API Gateway → Cloud Function (Node.js) → YDB serverless
Админка (PWA) ──┘                        └─→ Telegram-бот
```

Firebase (Firestore, Auth, FCM) и Apps Script полностью заменяются.
Вход в админку — по одному паролю (`ADMIN_PASSWORD`), защита от двойного
бронирования встроена: при заявке слот переводится в `hold`.

## Состав

| Файл | Что это |
|------|---------|
| `backend/index.js` | Cloud Function: весь API + Telegram |
| `schema.sql` | Таблицы YDB (`slots`, `bookings`) |
| `apigw.yaml` | Спецификация API Gateway |
| `deploy.sh` | Скрипт деплоя через yc CLI |
| `admin/index.html` | Админка-PWA, работающая через API |
| `form/form-block.html` | JS формы для Wfolio (стили/разметка прежние) |
| `scripts/migrate-from-firebase.js` | Выгрузка данных из Firestore → YQL |

## Порядок развёртывания

1. **Платёжный аккаунт** — привязан ✅ (без него ресурсы не создаются;
   serverless-нагрузка проекта укладывается в бесплатные лимиты).
2. **YDB**: консоль → Managed Service for YDB → Создать БД → Serverless.
   Со страницы БД скопировать **Эндпоинт** и **Размещение базы данных**.
   Во вкладке «Запросы» выполнить `schema.sql`.
3. **Деплой**: установить [yc CLI](https://yandex.cloud/ru/docs/cli/quickstart),
   `yc init`, затем:
   ```bash
   FOLDER_ID=b1g5f3ibgkjuf25m2vp9 \
   YDB_ENDPOINT='grpcs://ydb.serverless.yandexcloud.net:2135' \
   YDB_DATABASE='/ru-central1/…/…' \
   ADMIN_PASSWORD='придумать-пароль-для-Даши' \
   TELEGRAM_TOKEN='…' TELEGRAM_CHAT_ID='…' \
   ./yc/deploy.sh
   ```
   Скрипт выведет `API URL`.
4. **Подставить API URL** в `admin/index.html` и `form/form-block.html`
   (переменная `API_URL`).
5. **Данные**: `node scripts/migrate-from-firebase.js email пароль` —
   вывод (UPSERT-запросы) вставить в консоль YDB → «Запросы».
6. **Статика**: админку можно оставить на GitHub Pages (данные при этом
   уже в РФ) или перенести в Object Storage + свой домен.
7. **Форма**: в HTML-блоке на Wfolio заменить `<script>` на версию из
   `form/form-block.html` (стили и разметка не меняются).
8. После проверки — отключить/удалить проект Firebase, обновить политику
   конфиденциальности (место хранения данных — РФ).

## Что теряется / меняется

- Push в PWA (FCM) — уходит; основной канал уведомлений — Telegram
  (при желании можно добавить свой web-push позже).
- Живые обновления в админке заменены поллингом раз в 20 сек +
  pull-to-refresh.
- Вход по email+паролю → вход по одному паролю.

## Instagram-бот (отдельно от записи)

В `yc/ig-bot/` живёт независимый сервис: комментарий с ключевым словом под
постом → личное сообщение автору. Своя функция, свой API Gateway
(`/api/ig/…`), свои таблицы (`ig_triggers`, `ig_replied`, `ig_token`),
свой деплой (`yc/ig-bot/deploy.sh`). Система записи им не затрагивается.
Подробности и чек-лист настройки Meta — в `yc/ig-bot/README.md`.
