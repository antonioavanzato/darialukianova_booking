/**
 * =====================================================================
 * SEED PACKAGES — заполнение коллекции `packages` в Firestore
 * ---------------------------------------------------------------------
 * Заливает индивидуальные пакеты Дарьи (по актуальному прайсу) одним
 * запуском. Групповые форматы (хор, мастер-класс, групповой вокал)
 * сюда НЕ входят — они оформляются через Telegram.
 *
 * ЗАПУСК (один раз, локально):
 *   1) npm install firebase-admin
 *   2) положите рядом ключ сервис-аккаунта как service-account.json
 *      (Firebase → Project settings → Service accounts → Generate new
 *       private key) — ТОТ ЖЕ ключ, что пойдёт в Apps Script.
 *   3) node seed-packages.js
 *
 * Повторный запуск перезапишет пакеты с теми же ID (idempotent).
 * ⚠️ service-account.json НЕ коммитить (см. .gitignore).
 * =====================================================================
 */
const admin = require("firebase-admin");
const serviceAccount = require("./service-account.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// id — стабильные, чтобы повторный запуск обновлял, а не плодил дубли.
const PACKAGES = [
  { id: "probnoe",        title: "Пробное занятие",   price: 2000,  lessonsCount: 1, description: "50 минут · знакомство",    active: true },
  { id: "razovoe-50",     title: "Разовое занятие",   price: 2800,  lessonsCount: 1, description: "50 минут",                 active: true },
  { id: "razovoe-75",     title: "Разовое занятие",   price: 4200,  lessonsCount: 1, description: "1 час 15 минут",           active: true },
  { id: "razovoe-100",    title: "Разовое занятие",   price: 5200,  lessonsCount: 1, description: "1 час 40 минут",           active: true },
  { id: "abonement-4-50", title: "Абонемент · 4 занятия", price: 10400, lessonsCount: 4, description: "по 50 минут · 1 месяц",      active: true },
  { id: "abonement-8-50", title: "Абонемент · 8 занятий", price: 20000, lessonsCount: 8, description: "по 50 минут · 2 месяца",     active: true },
  { id: "abonement-4-75", title: "Абонемент · 4 занятия", price: 16000, lessonsCount: 4, description: "по 1 ч 15 мин · 1 месяц",    active: true },
  { id: "abonement-8-75", title: "Абонемент · 8 занятий", price: 31200, lessonsCount: 8, description: "по 1 ч 15 мин · 2 месяца",   active: true }
];

(async function () {
  const batch = db.batch();
  PACKAGES.forEach(function (p) {
    const ref = db.collection("packages").doc(p.id);
    batch.set(ref, {
      title: p.title,
      price: p.price,
      lessonsCount: p.lessonsCount,
      description: p.description,
      active: p.active
    });
  });
  await batch.commit();
  console.log("✓ Загружено пакетов: " + PACKAGES.length);
  process.exit(0);
})().catch(function (e) {
  console.error("Ошибка seed:", e);
  process.exit(1);
});
