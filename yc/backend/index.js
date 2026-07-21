/**
 * =====================================================================
 * API записи Дарьи Лукьяновой — Yandex Cloud Function
 * ---------------------------------------------------------------------
 * Заменяет связку Firebase (Firestore + Auth + rules) и Apps Script.
 * Данные — в YDB serverless (Россия), уведомления — Telegram.
 *
 * Переменные окружения функции:
 *   YDB_ENDPOINT      grpcs://ydb.serverless.yandexcloud.net:2135
 *   YDB_DATABASE      /ru-central1/…/… (из страницы БД)
 *   ADMIN_PASSWORD    пароль входа Даши в админку
 *   JWT_SECRET        любая длинная случайная строка
 *   TELEGRAM_TOKEN    токен бота (опционально)
 *   TELEGRAM_CHAT_ID  chat_id Даши (опционально)
 *
 * Роуты (через API Gateway, префикс /api):
 *   POST /api/login                      {password} → {token}
 *   GET  /api/availability               публично: свободные интервалы по датам
 *   POST /api/bookings                   публично: {package,date,start} создать заявку
 *   GET  /api/admin/bookings             админ: все заявки
 *   PATCH /api/admin/bookings/{id}       админ: {status} | {delete:true}
 *   GET  /api/admin/windows              админ: окна доступности
 *   POST /api/admin/windows              админ: открыть интервал {date,start,end,repeatWeeks?}
 *   DELETE /api/admin/windows/{id}       админ: убрать интервал
 * =====================================================================
 */
'use strict';
const crypto = require('crypto');
const { Driver, getCredentialsFromEnv, TypedValues } = require('ydb-sdk');

const DIRECTIONS = ['вокал', 'фортепиано', 'сольфеджио', 'групповой вокал', 'хор', 'мастер-класс'];

// Каталог пакетов из прайса. id используется формой (?pkg=...)
const PACKAGES = {
  'trial':      { title: 'Пробное занятие',                 dur: 50,  price: 2000 },
  'single-50':  { title: 'Разовое занятие · 50 минут',      dur: 50,  price: 2800 },
  'single-75':  { title: 'Разовое занятие · 1 ч 15 мин',    dur: 75,  price: 4200 },
  'single-100': { title: 'Разовое занятие · 1 ч 40 мин',    dur: 100, price: 5200 },
  'sub4-50':    { title: 'Абонемент 4 занятия по 50 минут', dur: 50,  price: 10400 },
  'sub8-50':    { title: 'Абонемент 8 занятий по 50 минут', dur: 50,  price: 20000 },
  'sub4-75':    { title: 'Абонемент 4 занятия по 1 ч 15 мин', dur: 75, price: 16000 },
  'sub8-75':    { title: 'Абонемент 8 занятий по 1 ч 15 мин', dur: 75, price: 31200 },
  'group-50':   { title: 'Групповой вокал · 50 минут',      dur: 50,  price: 2000 },
  'group-100':  { title: 'Групповой вокал · 1 ч 40 мин',    dur: 100, price: 3500 },
  'choir-once': { title: 'Хор · разовое занятие',           dur: 110, price: 2000 },
  'choir-sub4': { title: 'Хор · абонемент на 4 занятия',    dur: 110, price: 7400 },
  'mk':         { title: 'Мастер-класс · 1 ч 40 мин',       dur: 100, price: 3500 },
};

// «Сегодня» по Москве (UTC+3) и минимальная дата записи (за 2 дня)
function mskToday() {
  return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
}
function minBookingDate() {
  const d = new Date(Date.now() + 3 * 3600e3);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
}
function addMin(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + min;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
function hmToMin(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; }
function minToHm(t) { return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }

// Слить пересекающиеся и смежные интервалы ([s,e], минуты от полуночи).
// `<=` — чтобы смежные окна 13:00–15:00 и 15:00–17:00 стали одним 13:00–17:00
// (занятие может «перетечь» в соседний свободный интервал).
function mergeIntervals(list) {
  const s = list.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}
// Вычесть занятые интервалы из свободных.
function subtractBusy(free, busy) {
  let res = free.map((x) => [x[0], x[1]]);
  for (const b of busy) {
    const next = [];
    for (const f of res) {
      if (b[1] <= f[0] || b[0] >= f[1]) { next.push(f); continue; }
      if (b[0] > f[0]) next.push([f[0], b[0]]);
      if (b[1] < f[1]) next.push([b[1], f[1]]);
    }
    res = next;
  }
  return res.filter((iv) => iv[1] > iv[0]);
}

// Карта дата → свободные интервалы (окна Даши минус активные брони) начиная с fromDate.
async function computeAvailability(fromDate) {
  const wins = (await query(
    'DECLARE $min AS Utf8; SELECT date, start_min, end_min FROM windows WHERE date >= $min;',
    { $min: TypedValues.utf8(fromDate) }))[0] || [];
  const bks = (await query(
    'DECLARE $min AS Utf8; SELECT slot_date, slot_time, duration_min, status FROM bookings WHERE slot_date >= $min;',
    { $min: TypedValues.utf8(fromDate) }))[0] || [];
  const winByDate = {}, busyByDate = {};
  for (const w of wins) (winByDate[w.date] = winByDate[w.date] || []).push([Number(w.start_min), Number(w.end_min)]);
  for (const b of bks) {
    if (b.status === 'cancelled') continue;
    const s = hmToMin(b.slot_time);
    (busyByDate[b.slot_date] = busyByDate[b.slot_date] || []).push([s, s + (Number(b.duration_min) || 50)]);
  }
  const out = {};
  for (const date of Object.keys(winByDate)) {
    out[date] = subtractBusy(mergeIntervals(winByDate[date]), busyByDate[date] || []);
  }
  return out;
}

let driver = null;
async function getDriver() {
  if (driver) return driver;
  driver = new Driver({
    endpoint: process.env.YDB_ENDPOINT,
    database: process.env.YDB_DATABASE,
    authService: getCredentialsFromEnv(),
  });
  if (!(await driver.ready(8000))) throw new Error('YDB connect timeout');
  return driver;
}

async function query(text, params) {
  const d = await getDriver();
  return d.tableClient.withSession(async (session) => {
    const prepared = await session.prepareQuery(text);
    const res = await session.executeQuery(prepared, params || {});
    return res.resultSets.map((rs) => rowsOf(rs));
  });
}

function rowsOf(rs) {
  const cols = rs.columns.map((c) => c.name);
  return (rs.rows || []).map((r) => {
    const o = {};
    r.items.forEach((it, i) => { o[cols[i]] = plain(it); });
    return o;
  });
}
function plain(v) {
  if (v == null) return null;
  if (v.textValue !== undefined && v.textValue !== null) return v.textValue;
  if (v.uint32Value !== undefined && v.uint32Value !== null) return v.uint32Value;
  if (v.uint64Value !== undefined && v.uint64Value !== null) return Number(v.uint64Value);
  if (v.int64Value !== undefined && v.int64Value !== null) return Number(v.int64Value);
  if (v.nullFlagValue !== undefined) return null;
  return v.value !== undefined ? v.value : null;
}

/* ---------- auth: компактный HMAC-токен ---------- */
function signToken() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000; // 30 дней
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function checkToken(headers) {
  const h = headers.Authorization || headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const good = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); }
  catch (e) { return false; }
}

/* ---------- telegram ---------- */
async function sendTelegram(b) {
  const token = process.env.TELEGRAM_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = '🎵 <b>Новая заявка</b>\n\n👤 <b>' + esc(b.name) + '</b>\n📞 ' + esc(b.phone) +
    (b.telegram ? '\n✈️ ' + esc(b.telegram) : '') +
    '\n🎼 ' + esc(b.direction) + (b.price ? ' · ' + b.price + ' ₽' : '') +
    '\n📅 ' + esc(b.slot_date) + ' в ' + esc(b.slot_time) +
    (b.comment ? '\n\n💬 ' + esc(b.comment) : '');
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.warn('telegram', e); }
}

/* ---------- web push (iOS PWA / браузеры) ---------- */
let webpush = null;
function getWebpush() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  if (!webpush) {
    webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:style_of_live@mail.ru',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY
    );
  }
  return webpush;
}

function subId(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex');
}

async function savePushSubscription(data) {
  const endpoint = String((data && data.endpoint) || '');
  const keys = (data && data.keys) || {};
  if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth)
    return { code: 400, body: { error: 'Неверная подписка' } };
  await query(
    'DECLARE $id AS Utf8; DECLARE $endpoint AS Utf8; DECLARE $p256dh AS Utf8;\n' +
    'DECLARE $auth AS Utf8; DECLARE $created AS Uint64;\n' +
    'UPSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)\n' +
    'VALUES ($id, $endpoint, $p256dh, $auth, $created);',
    { $id: TypedValues.utf8(subId(endpoint)), $endpoint: TypedValues.utf8(endpoint),
      $p256dh: TypedValues.utf8(String(keys.p256dh)), $auth: TypedValues.utf8(String(keys.auth)),
      $created: TypedValues.uint64(Date.now()) }
  );
  return { code: 200, body: { ok: true } };
}

async function deletePushSubscription(data) {
  const endpoint = String((data && data.endpoint) || '');
  if (!endpoint) return { code: 400, body: { error: 'Нет endpoint' } };
  await query('DECLARE $id AS Utf8; DELETE FROM push_subscriptions WHERE id = $id;',
    { $id: TypedValues.utf8(subId(endpoint)) });
  return { code: 200, body: { ok: true } };
}

async function sendWebPush(b) {
  const wp = getWebpush();
  if (!wp) return;
  const rows = (await query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions;'))[0] || [];
  if (!rows.length) return;
  const payload = JSON.stringify({
    title: '🎵 Новая заявка',
    body: b.name + ' · ' + b.direction + '\n' + b.slot_date + ' в ' + b.slot_time,
  });
  await Promise.all(rows.map(async (r) => {
    try {
      await wp.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, { TTL: 3600 });
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410))
        await query('DECLARE $id AS Utf8; DELETE FROM push_subscriptions WHERE id = $id;',
          { $id: TypedValues.utf8(r.id) }).catch(() => {});
      else console.warn('webpush', e && e.statusCode, e && e.body);
    }
  }));
}

/* ---------- handlers ---------- */
// Публично: свободные интервалы доступности по датам (>= минимум за 2 дня).
async function publicAvailability() {
  const av = await computeAvailability(minBookingDate());
  const out = Object.keys(av).sort()
    .map((date) => ({ date, free: av[date].map((iv) => [iv[0], iv[1]]) }))
    .filter((d) => d.free.length);
  return { code: 200, body: out };
}

async function createBooking(data) {
  const name = String(data.name || '').trim();
  const phone = String(data.phone || '').trim();
  if (name.length < 2 || name.length > 120) return { code: 400, body: { error: 'Укажите имя' } };
  if (phone.replace(/\D/g, '').length < 11 || phone.length > 40) return { code: 400, body: { error: 'Укажите телефон' } };
  if (String(data.comment || '').length > 2000) return { code: 400, body: { error: 'Слишком длинный комментарий' } };
  const pkg = PACKAGES[String(data.package || '')];
  if (!pkg) return { code: 400, body: { error: 'Неверный пакет' } };
  const date = String(data.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { code: 400, body: { error: 'Неверная дата' } };
  if (date < minBookingDate()) return { code: 400, body: { error: 'Запись возможна не позднее чем за 2 дня' } };
  const start = String(data.start || '');
  if (!/^\d{2}:\d{2}$/.test(start)) return { code: 400, body: { error: 'Выберите время' } };
  const startMin = hmToMin(start);
  // слот резервируется ровными часами (12–13, 13–14) даже если занятие 50 мин
  const slot = Math.ceil(pkg.dur / 60) * 60;
  const endMin = startMin + slot;

  // занятие целиком должно попадать в свободный интервал этой даты
  const av = await computeAvailability(minBookingDate());
  const free = av[date] || [];
  const fits = free.some((iv) => iv[0] <= startMin && endMin <= iv[1]);
  if (!fits) return { code: 409, body: { error: 'Это время уже недоступно — выберите другое' } };

  const id = crypto.randomUUID();
  await query(
    'DECLARE $id AS Utf8; DECLARE $package AS Utf8; DECLARE $price AS Uint32; DECLARE $dur AS Uint32;\n' +
    'DECLARE $name AS Utf8; DECLARE $phone AS Utf8; DECLARE $telegram AS Utf8;\n' +
    'DECLARE $comment AS Utf8; DECLARE $slot_date AS Utf8; DECLARE $slot_time AS Utf8;\n' +
    'DECLARE $created AS Uint64;\n' +
    'UPSERT INTO bookings (id, package, price, duration_min, name, phone, telegram, comment, status, slot_date, slot_time, created_at)\n' +
    'VALUES ($id, $package, $price, $dur, $name, $phone, $telegram, $comment, "pending", $slot_date, $slot_time, $created);',
    {
      $id: TypedValues.utf8(id),
      $package: TypedValues.utf8(pkg.title), $price: TypedValues.uint32(pkg.price),
      $dur: TypedValues.uint32(slot),
      $name: TypedValues.utf8(name), $phone: TypedValues.utf8(phone),
      $telegram: TypedValues.utf8(String(data.telegram || '')),
      $comment: TypedValues.utf8(String(data.comment || '')),
      $slot_date: TypedValues.utf8(date), $slot_time: TypedValues.utf8(start),
      $created: TypedValues.uint64(Date.now()),
    }
  );
  const notice = { name, phone, telegram: data.telegram, comment: data.comment,
    direction: pkg.title, slot_date: date, slot_time: start + '–' + minToHm(endMin), price: pkg.price };
  await sendTelegram(notice);
  try { await sendWebPush(notice); } catch (e) { console.warn('push', e); }
  return { code: 200, body: { ok: true, id } };
}

async function adminBookings() {
  const rows = await query('SELECT * FROM bookings ORDER BY created_at DESC;');
  return { code: 200, body: rows[0] };
}

async function patchBooking(id, data) {
  const b = (await query('DECLARE $id AS Utf8; SELECT id FROM bookings WHERE id = $id;',
    { $id: TypedValues.utf8(id) }))[0][0];
  if (!b) return { code: 404, body: { error: 'Заявка не найдена' } };

  if (data.delete) {
    await query('DECLARE $id AS Utf8; DELETE FROM bookings WHERE id = $id;', { $id: TypedValues.utf8(id) });
    return { code: 200, body: { ok: true } };
  }
  const status = data.status;
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) return { code: 400, body: { error: 'Неверный статус' } };
  // Доступность считается динамически: отменённая бронь освобождает время автоматически.
  await query('DECLARE $id AS Utf8; DECLARE $st AS Utf8; UPDATE bookings SET status = $st WHERE id = $id;',
    { $id: TypedValues.utf8(id), $st: TypedValues.utf8(status) });
  return { code: 200, body: { ok: true } };
}

// Окна доступности Даши (интервалы). Возвращаем HH:MM для удобства UI.
async function adminWindows() {
  const rows = (await query('SELECT id, date, start_min, end_min FROM windows;'))[0] || [];
  const out = rows.map((w) => ({
    id: w.id, date: w.date,
    start: minToHm(Number(w.start_min)), end: minToHm(Number(w.end_min)),
    start_min: Number(w.start_min), end_min: Number(w.end_min),
  })).sort((a, b) => (a.date === b.date ? a.start_min - b.start_min : a.date < b.date ? -1 : 1));
  return { code: 200, body: out };
}

async function createWindows(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) return { code: 400, body: { error: 'Неверная дата' } };
  if (!/^\d{2}:\d{2}$/.test(String(data.start || '')) || !/^\d{2}:\d{2}$/.test(String(data.end || '')))
    return { code: 400, body: { error: 'Укажите время начала и конца' } };
  const startMin = hmToMin(data.start), endMin = hmToMin(data.end);
  if (endMin <= startMin) return { code: 400, body: { error: 'Конец должен быть позже начала' } };
  const weeks = Math.min(Math.max(Number(data.repeatWeeks) || 1, 1), 12);
  const base = new Date(data.date + 'T00:00:00Z');
  for (let w = 0; w < weeks; w++) {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + w * 7);
    const ds = d.toISOString().slice(0, 10);
    await query(
      'DECLARE $id AS Utf8; DECLARE $date AS Utf8; DECLARE $s AS Uint32; DECLARE $e AS Uint32; DECLARE $created AS Uint64;\n' +
      'UPSERT INTO windows (id, date, start_min, end_min, created_at) VALUES ($id, $date, $s, $e, $created);',
      { $id: TypedValues.utf8(crypto.randomUUID()), $date: TypedValues.utf8(ds),
        $s: TypedValues.uint32(startMin), $e: TypedValues.uint32(endMin), $created: TypedValues.uint64(Date.now()) });
  }
  return { code: 200, body: { ok: true, created: weeks } };
}

async function deleteWindow(id) {
  await query('DECLARE $id AS Utf8; DELETE FROM windows WHERE id = $id;', { $id: TypedValues.utf8(id) });
  return { code: 200, body: { ok: true } };
}

/* ---------- router ---------- */
module.exports.handler = async function (event) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const rawPath = (event.url && !event.url.includes('{')) ? event.url
    : (event.path && !event.path.includes('{')) ? event.path
    : (event.requestContext && event.requestContext.path) || event.url || event.path || '/';
  const path = rawPath.split('?')[0].replace(/\/+$/, '');
  const qs = event.queryStringParameters || {};
  const headers = event.headers || {};
  let data = {};
  if (event.body) {
    try {
      data = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch (e) { /* пустое или не-JSON тело */ }
  }

  const respond = (r) => ({
    statusCode: r.code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify(r.body),
  });

  try {
    if (method === 'OPTIONS') return respond({ code: 204, body: {} });

    if (method === 'POST' && path.endsWith('/login')) {
      const wantLogin = process.env.ADMIN_LOGIN;
      if (wantLogin && (data.login || '').trim().toLowerCase() !== wantLogin.toLowerCase())
        return respond({ code: 401, body: { error: 'Неверный логин или пароль' } });
      if (!data.password || data.password !== process.env.ADMIN_PASSWORD)
        return respond({ code: 401, body: { error: 'Неверный логин или пароль' } });
      return respond({ code: 200, body: { token: signToken() } });
    }
    if (method === 'GET' && path.endsWith('/availability') && !path.includes('/admin/'))
      return respond(await publicAvailability());
    if (method === 'POST' && path.endsWith('/bookings') && !path.includes('/admin/'))
      return respond(await createBooking(data));

    // всё, что ниже, — только для Даши
    if (!checkToken(headers)) return respond({ code: 401, body: { error: 'Не авторизован' } });

    if (path.endsWith('/admin/push')) {
      if (method === 'GET') return respond({ code: 200, body: { publicKey: process.env.VAPID_PUBLIC_KEY || null } });
      if (method === 'POST') return respond(await savePushSubscription(data));
      if (method === 'DELETE') return respond(await deletePushSubscription(data));
    }

    const m = path.match(/\/admin\/(bookings|windows)(?:\/([^/]+))?$/);
    if (!m) return respond({ code: 404, body: { error: 'Не найдено' } });
    const [, coll, id] = m;
    if (coll === 'bookings' && method === 'GET') return respond(await adminBookings());
    if (coll === 'bookings' && method === 'PATCH' && id) return respond(await patchBooking(id, data));
    if (coll === 'windows' && method === 'GET') return respond(await adminWindows());
    if (coll === 'windows' && method === 'POST') return respond(await createWindows(data));
    if (coll === 'windows' && method === 'DELETE' && id) return respond(await deleteWindow(id));
    return respond({ code: 404, body: { error: 'Не найдено' } });
  } catch (e) {
    console.error(e);
    return respond({ code: 500, body: { error: 'Внутренняя ошибка: ' + (e && e.message ? e.message : e) } });
  }
};
