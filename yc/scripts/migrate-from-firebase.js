/**
 * Перенос данных Firestore → YDB.
 * Читает slots и bookings из Firebase (входом Даши) и печатает готовые
 * YQL-запросы UPSERT — их нужно вставить в консоль YDB (вкладка «Запросы»).
 *
 * Запуск:  node migrate-from-firebase.js dasha@email.ru 'пароль'
 */
'use strict';
const API_KEY = 'AIzaSyC5ZzSnqXvA5p8b8NYjOPtRjHB2sDTkJmE';
const PROJECT = 'daria-booking-baae5';

const q = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function val(f) {
  if (!f) return null;
  if (f.stringValue !== undefined) return f.stringValue;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.timestampValue !== undefined) return Date.parse(f.timestampValue);
  return null;
}

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) { console.error('Использование: node migrate-from-firebase.js email пароль'); process.exit(1); }

  const auth = await (await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }) })).json();
  if (!auth.idToken) { console.error('Ошибка входа:', auth.error && auth.error.message); process.exit(1); }

  for (const coll of ['slots', 'bookings']) {
    const res = await (await fetch(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${coll}?pageSize=300`,
      { headers: { Authorization: 'Bearer ' + auth.idToken } })).json();
    const docs = res.documents || [];
    console.log(`\n-- ${coll}: ${docs.length} документов`);
    for (const d of docs) {
      const id = d.name.split('/').pop();
      const f = d.fields || {};
      if (coll === 'slots') {
        console.log(`UPSERT INTO slots (id, date, time, direction, duration_min, status, created_at) VALUES (` +
          `${q(id)}, ${q(val(f.date))}, ${q(val(f.time))}, ${q(val(f.direction))}, ` +
          `${Number(val(f.durationMin)) || 50}u, ${q(val(f.status) || 'free')}, ${val(f.createdAt) || Date.now()}ul);`);
      } else {
        console.log(`UPSERT INTO bookings (id, slot_id, direction, name, phone, telegram, comment, status, slot_date, slot_time, created_at) VALUES (` +
          `${q(id)}, ${q(val(f.slotId))}, ${q(val(f.direction))}, ${q(val(f.name))}, ${q(val(f.phone))}, ` +
          `${q(val(f.telegram))}, ${q(val(f.comment))}, ${q(val(f.status) || 'pending')}, ` +
          `${q(val(f.slotDate))}, ${q(val(f.slotTime))}, ${val(f.createdAt) || Date.now()}ul);`);
      }
    }
  }
}
main();
