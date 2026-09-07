/**
 * =====================================================================
 * Instagram comment-to-DM бот — отдельная Yandex Cloud Function
 * ---------------------------------------------------------------------
 * Под постом Даша пишет «напишите слово НОТЫ в комментариях» — бот ловит
 * вебхук о новом комментарии, проверяет ключевое слово и отправляет автору
 * личное сообщение (private reply) с заготовленным текстом.
 *
 * Функция записи (yc/backend) не затрагивается: свой код, свои таблицы
 * (ig_triggers, ig_replied, ig_token), свой API Gateway.
 *
 * Переменные окружения функции:
 *   YDB_ENDPOINT      grpcs://ydb.serverless.yandexcloud.net:2135
 *   YDB_DATABASE      /ru-central1/…/… (та же база, что и у записи)
 *   JWT_SECRET        тот же секрет, что у функции записи (общий вход в админку)
 *   IG_VERIFY_TOKEN   произвольная строка, её же вписать в Meta → Webhooks
 *   IG_APP_SECRET     App Secret из Meta (для проверки подписи, опционально)
 *   IG_APP_ID         App ID из Meta (нужен только для справки в админке)
 *
 * Роуты (через API Gateway, префикс /api/ig):
 *   GET  /api/ig/webhook                 Meta: верификация подписки (hub.challenge)
 *   POST /api/ig/webhook                 Meta: события о новых комментариях
 *   GET  /api/ig/admin/triggers          админ: список ключевых слов
 *   POST /api/ig/admin/triggers          админ: {keyword, replyText, enabled?}
 *   PATCH /api/ig/admin/triggers/{id}    админ: {keyword?, replyText?, enabled?}
 *   DELETE /api/ig/admin/triggers/{id}   админ: удалить
 *   GET  /api/ig/admin/status            админ: состояние токена и статистика
 *   POST /api/ig/admin/token             админ: {accessToken, igUserId?} вписать токен
 *
 * Таймер-триггер (раз в сутки) продлевает 60-дневный токен без ручных действий.
 * =====================================================================
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const { Driver, getCredentialsFromEnv, TypedValues } = require('ydb-sdk');

const GRAPH_HOST = 'graph.instagram.com';
const GRAPH_VER = 'v23.0';
// Продлевать токен, если до его конца осталось меньше 20 дней
// (Meta разрешает продление начиная с 24 часов жизни токена).
const REFRESH_BEFORE_MS = 20 * 24 * 3600 * 1000;
const MAX_REPLY_LEN = 900;

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

/* ---------- auth: тот же HMAC-токен, что выдаёт функция записи ---------- */
function checkToken(headers) {
  const h = headers.Authorization || headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const good = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); }
  catch (e) { return false; }
}

/* ---------- Graph API поверх встроенного https (без axios/node-fetch) ---------- */
function graphRequest(method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      host: GRAPH_HOST, method, path,
      headers: Object.assign({ 'Accept': 'application/json' },
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      timeout: 7000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch (e) { /* Graph вернул не-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const msg = (json.error && json.error.message) || ('HTTP ' + res.statusCode);
        reject(new Error('Instagram API: ' + msg));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Instagram API: таймаут запроса')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------- токен доступа ---------- */
async function loadToken() {
  const row = (await query("SELECT id, access_token, ig_user_id, expires_at, refreshed_at FROM ig_token WHERE id = 'default';"))[0][0];
  return row || null;
}

async function saveToken(accessToken, igUserId, expiresAt) {
  await query(
    'DECLARE $token AS Utf8; DECLARE $user AS Utf8; DECLARE $exp AS Uint64; DECLARE $ref AS Uint64;\n' +
    "UPSERT INTO ig_token (id, access_token, ig_user_id, expires_at, refreshed_at)\n" +
    "VALUES ('default', $token, $user, $exp, $ref);",
    { $token: TypedValues.utf8(String(accessToken)), $user: TypedValues.utf8(String(igUserId || '')),
      $exp: TypedValues.uint64(expiresAt), $ref: TypedValues.uint64(Date.now()) }
  );
}

// Продление 60-дневного токена. Вызывается по таймеру раз в сутки; если до
// конца жизни токена ещё далеко — ничего не делаем (Meta не любит частых обменов).
async function refreshTokenIfNeeded(force) {
  const row = await loadToken();
  if (!row || !row.access_token) return { refreshed: false, reason: 'Токен ещё не задан' };
  const expiresAt = Number(row.expires_at) || 0;
  if (!force && expiresAt - Date.now() > REFRESH_BEFORE_MS)
    return { refreshed: false, reason: 'Продление пока не требуется' };
  const res = await graphRequest('GET',
    '/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(row.access_token));
  const ttl = Number(res.expires_in) || 60 * 24 * 3600; // Graph отдаёт секунды
  await saveToken(res.access_token || row.access_token, row.ig_user_id, Date.now() + ttl * 1000);
  return { refreshed: true, expiresIn: ttl };
}

/* ---------- отправка личного сообщения ---------- */
// Приватный ответ на комментарий. Основной путь — /{comment-id}/private_replies,
// как в документации Instagram Messaging; если он недоступен, пробуем
// /{ig-user-id}/messages с recipient.comment_id (то же самое новым способом).
async function sendPrivateReply(commentId, text, tokenRow) {
  const qs = '?access_token=' + encodeURIComponent(tokenRow.access_token);
  try {
    return await graphRequest('POST', '/' + GRAPH_VER + '/' + encodeURIComponent(commentId) + '/private_replies' + qs,
      { message: text });
  } catch (e) {
    if (!tokenRow.ig_user_id) throw e;
    console.warn('private_replies не сработал, пробуем /messages:', e.message);
    return graphRequest('POST', '/' + GRAPH_VER + '/' + encodeURIComponent(tokenRow.ig_user_id) + '/messages' + qs,
      { recipient: { comment_id: commentId }, message: { text } });
  }
}

/* ---------- ключевые слова ---------- */
// Нормализация: нижний регистр, ё→е, всё кроме букв и цифр — в пробелы.
function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
// Слово считается совпавшим, если встречается в тексте как отдельное слово
// (или как отдельная фраза, если ключ состоит из нескольких слов).
function matchesKeyword(text, keyword) {
  const t = ' ' + normalize(text) + ' ';
  const k = ' ' + normalize(keyword) + ' ';
  return k.trim().length > 0 && t.indexOf(k) >= 0;
}

async function activeTriggers() {
  const rows = (await query('SELECT id, keyword, reply_text, enabled, hits, created_at FROM ig_triggers;'))[0] || [];
  return rows.filter((t) => Number(t.enabled) === 1);
}

/* ---------- обработка вебхука ---------- */
// Подпись Meta: X-Hub-Signature-256 = sha256 HMAC тела на App Secret.
function checkSignature(headers, rawBody) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) return true; // подпись не проверяем, если секрет не задан
  const got = String(headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '');
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(got), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Достаём из payload все комментарии: entry[].changes[] с field = 'comments'.
function extractComments(data) {
  const out = [];
  for (const entry of (data && data.entry) || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments') continue;
      const v = ch.value || {};
      if (!v.id) continue;
      out.push({
        id: String(v.id),
        text: String(v.text || ''),
        userId: String((v.from && v.from.id) || ''),
        username: String((v.from && v.from.username) || ''),
        mediaId: String((v.media && v.media.id) || ''),
      });
    }
  }
  return out;
}

async function handleWebhook(data) {
  // ДИАГНОСТИКА: пишем всё, что пришло от Meta, — иначе при молчании бота
  // непонятно, дошло ли событие вообще и что в нём было.
  console.log('IG-DEBUG вебхук получен:', JSON.stringify(data).slice(0, 2000));
  const comments = extractComments(data);
  console.log('IG-DEBUG комментариев в событии:', comments.length,
    comments.map((c) => c.userId + ': ' + c.text).join(' | ').slice(0, 500));
  if (!comments.length) return { code: 200, body: { ok: true, handled: 0 } };

  const tokenRow = await loadToken();
  if (!tokenRow || !tokenRow.access_token) {
    console.warn('Токен Instagram не задан — комментарии пропущены');
    return { code: 200, body: { ok: true, handled: 0, warning: 'Токен Instagram не задан' } };
  }
  const triggers = await activeTriggers();
  console.log('IG-DEBUG токен есть, ig_user_id:', tokenRow.ig_user_id,
    '· активных слов:', triggers.length, triggers.map((t) => t.keyword).join(','));
  let handled = 0;

  for (const c of comments) {
    // свои же комментарии игнорируем, иначе бот ответит сам себе
    if (tokenRow.ig_user_id && c.userId === String(tokenRow.ig_user_id)) {
      console.log('IG-DEBUG пропуск: комментарий самого владельца аккаунта');
      continue;
    }
    const trig = triggers.find((t) => matchesKeyword(c.text, t.keyword));
    if (!trig) {
      console.log('IG-DEBUG пропуск: ни одно слово не совпало с текстом', JSON.stringify(c.text));
      continue;
    }
    console.log('IG-DEBUG совпало слово:', trig.keyword, '· отправляем ответ на комментарий', c.id);

    // дедупликация: Meta может прислать один и тот же комментарий повторно
    const seen = (await query('DECLARE $id AS Utf8; SELECT comment_id FROM ig_replied WHERE comment_id = $id;',
      { $id: TypedValues.utf8(c.id) }))[0][0];
    if (seen) continue;
    // отметку ставим ДО отправки: повторный вебхук во время отправки
    // не должен приводить ко второму сообщению
    await query(
      'DECLARE $id AS Utf8; DECLARE $trig AS Utf8; DECLARE $user AS Utf8; DECLARE $media AS Utf8; DECLARE $created AS Uint64;\n' +
      'UPSERT INTO ig_replied (comment_id, trigger_id, user_id, media_id, created_at)\n' +
      'VALUES ($id, $trig, $user, $media, $created);',
      { $id: TypedValues.utf8(c.id), $trig: TypedValues.utf8(String(trig.id)),
        $user: TypedValues.utf8(c.userId), $media: TypedValues.utf8(c.mediaId),
        $created: TypedValues.uint64(Date.now()) }
    );

    try {
      const res = await sendPrivateReply(c.id, String(trig.reply_text || ''), tokenRow);
      console.log('IG-DEBUG сообщение отправлено, ответ Instagram:', JSON.stringify(res).slice(0, 500));
      await query('DECLARE $id AS Utf8; DECLARE $hits AS Uint64; UPDATE ig_triggers SET hits = $hits WHERE id = $id;',
        { $id: TypedValues.utf8(String(trig.id)), $hits: TypedValues.uint64((Number(trig.hits) || 0) + 1) });
      handled++;
    } catch (e) {
      // не смогли отправить — снимаем отметку, чтобы повтор от Meta дал ещё шанс
      console.warn('Не удалось отправить сообщение по комментарию', c.id, e && e.message);
      await query('DECLARE $id AS Utf8; DELETE FROM ig_replied WHERE comment_id = $id;',
        { $id: TypedValues.utf8(c.id) }).catch(() => {});
    }
  }
  return { code: 200, body: { ok: true, handled } };
}

/* ---------- админ: ключевые слова ---------- */
async function adminTriggers() {
  const rows = (await query('SELECT id, keyword, reply_text, enabled, hits, created_at FROM ig_triggers;'))[0] || [];
  const out = rows.map((t) => ({
    id: t.id, keyword: t.keyword, reply_text: t.reply_text,
    enabled: Number(t.enabled) === 1, hits: Number(t.hits) || 0,
    created_at: Number(t.created_at) || null,
  })).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return { code: 200, body: out };
}

function validateTrigger(keyword, replyText) {
  const k = normalize(keyword);
  if (k.length < 2 || k.length > 60) return 'Ключевое слово: от 2 до 60 символов';
  const r = String(replyText == null ? '' : replyText).trim();
  if (r.length < 1) return 'Укажите текст ответа';
  if (r.length > MAX_REPLY_LEN) return 'Текст ответа длиннее ' + MAX_REPLY_LEN + ' символов';
  return null;
}

async function createTrigger(data) {
  const keyword = normalize(data.keyword);
  const replyText = String(data.replyText == null ? '' : data.replyText).trim();
  const err = validateTrigger(keyword, replyText);
  if (err) return { code: 400, body: { error: err } };

  const rows = (await query('SELECT id, keyword FROM ig_triggers;'))[0] || [];
  if (rows.some((t) => t.keyword === keyword))
    return { code: 409, body: { error: 'Такое ключевое слово уже есть' } };

  const id = crypto.randomUUID();
  await query(
    'DECLARE $id AS Utf8; DECLARE $kw AS Utf8; DECLARE $txt AS Utf8;\n' +
    'DECLARE $en AS Uint32; DECLARE $created AS Uint64;\n' +
    'UPSERT INTO ig_triggers (id, keyword, reply_text, enabled, hits, created_at)\n' +
    'VALUES ($id, $kw, $txt, $en, 0, $created);',
    { $id: TypedValues.utf8(id), $kw: TypedValues.utf8(keyword), $txt: TypedValues.utf8(replyText),
      $en: TypedValues.uint32(data.enabled === false ? 0 : 1), $created: TypedValues.uint64(Date.now()) }
  );
  return { code: 200, body: { ok: true, id } };
}

async function patchTrigger(id, data) {
  const cur = (await query('DECLARE $id AS Utf8; SELECT id, keyword, reply_text, enabled FROM ig_triggers WHERE id = $id;',
    { $id: TypedValues.utf8(id) }))[0][0];
  if (!cur) return { code: 404, body: { error: 'Ключевое слово не найдено' } };

  const keyword = data.keyword === undefined ? cur.keyword : normalize(data.keyword);
  const replyText = data.replyText === undefined ? cur.reply_text : String(data.replyText).trim();
  const err = validateTrigger(keyword, replyText);
  if (err) return { code: 400, body: { error: err } };
  const enabled = data.enabled === undefined ? Number(cur.enabled) : (data.enabled ? 1 : 0);

  await query(
    'DECLARE $id AS Utf8; DECLARE $kw AS Utf8; DECLARE $txt AS Utf8; DECLARE $en AS Uint32;\n' +
    'UPDATE ig_triggers SET keyword = $kw, reply_text = $txt, enabled = $en WHERE id = $id;',
    { $id: TypedValues.utf8(id), $kw: TypedValues.utf8(keyword),
      $txt: TypedValues.utf8(replyText), $en: TypedValues.uint32(enabled) }
  );
  return { code: 200, body: { ok: true } };
}

async function deleteTrigger(id) {
  await query('DECLARE $id AS Utf8; DELETE FROM ig_triggers WHERE id = $id;', { $id: TypedValues.utf8(id) });
  return { code: 200, body: { ok: true } };
}

// Состояние бота: жив ли токен, сколько отправлено сообщений.
async function adminStatus() {
  const row = await loadToken();
  const replied = (await query('SELECT COUNT(*) AS cnt FROM ig_replied;'))[0][0];
  return { code: 200, body: {
    hasToken: !!(row && row.access_token),
    igUserId: (row && row.ig_user_id) || null,
    expiresAt: row ? Number(row.expires_at) || null : null,
    refreshedAt: row ? Number(row.refreshed_at) || null : null,
    repliedTotal: replied ? Number(replied.cnt) || 0 : 0,
    appId: process.env.IG_APP_ID || null,
  } };
}

// Первичная вставка токена (получается вручную через Meta UI) и ручное продление.
async function adminSetToken(data) {
  const accessToken = String(data.accessToken || '').trim();
  if (accessToken.length < 20) return { code: 400, body: { error: 'Укажите access-токен' } };
  const igUserId = String(data.igUserId || '').trim();
  const days = Math.min(Math.max(Number(data.expiresInDays) || 60, 1), 90);
  await saveToken(accessToken, igUserId, Date.now() + days * 24 * 3600 * 1000);
  return { code: 200, body: { ok: true } };
}

/* ---------- router ---------- */
module.exports.handler = async function (event) {
  // Таймер-триггер (event.messages, без httpMethod): продление токена.
  if (event && event.messages && !event.httpMethod) {
    try {
      const r = await refreshTokenIfNeeded(false);
      console.log('Продление токена:', JSON.stringify(r));
    } catch (e) { console.error('Не удалось продлить токен:', e && e.message); }
    return { statusCode: 200, body: 'ok' };
  }

  const method = (event.httpMethod || 'GET').toUpperCase();
  const rawPath = (event.url && !event.url.includes('{')) ? event.url
    : (event.path && !event.path.includes('{')) ? event.path
    : (event.requestContext && event.requestContext.path) || event.url || event.path || '/';
  const path = rawPath.split('?')[0].replace(/\/+$/, '');
  const qs = event.queryStringParameters || {};
  const headers = event.headers || {};
  // ДИАГНОСТИКА: без этой строки не отличить вебхук Meta от запроса админки
  console.log('IG-DEBUG запрос:', method, path);
  const rawBody = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : String(event.body))
    : '';
  let data = {};
  if (rawBody) {
    try { data = JSON.parse(rawBody); } catch (e) { /* пустое или не-JSON тело */ }
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

    // Meta проверяет подписку: нужно вернуть hub.challenge простым текстом.
    if (method === 'GET' && path.endsWith('/webhook')) {
      if (qs['hub.mode'] === 'subscribe' && qs['hub.verify_token'] === process.env.IG_VERIFY_TOKEN)
        return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: String(qs['hub.challenge'] || '') };
      return respond({ code: 403, body: { error: 'Неверный verify token' } });
    }
    if (method === 'POST' && path.endsWith('/webhook')) {
      if (!checkSignature(headers, rawBody)) {
        console.warn('IG-DEBUG вебхук отбит: подпись не совпала');
        return respond({ code: 403, body: { error: 'Неверная подпись' } });
      }
      return respond(await handleWebhook(data));
    }

    // всё, что ниже, — только для Даши (тот же токен, что и в основной админке)
    if (!checkToken(headers)) return respond({ code: 401, body: { error: 'Не авторизован' } });

    if (method === 'GET' && path.endsWith('/admin/status')) return respond(await adminStatus());
    if (method === 'POST' && path.endsWith('/admin/token')) return respond(await adminSetToken(data));
    if (method === 'POST' && path.endsWith('/admin/token/refresh')) {
      const r = await refreshTokenIfNeeded(true);
      return respond({ code: 200, body: r });
    }

    const m = path.match(/\/admin\/(triggers)(?:\/([^/]+))?$/);
    if (!m) return respond({ code: 404, body: { error: 'Не найдено' } });
    const [, coll, id] = m;
    if (coll === 'triggers' && method === 'GET') return respond(await adminTriggers());
    if (coll === 'triggers' && method === 'POST') return respond(await createTrigger(data));
    if (coll === 'triggers' && method === 'PATCH' && id) return respond(await patchTrigger(id, data));
    if (coll === 'triggers' && method === 'DELETE' && id) return respond(await deleteTrigger(id));
    return respond({ code: 404, body: { error: 'Не найдено' } });
  } catch (e) {
    console.error(e);
    return respond({ code: 500, body: { error: 'Внутренняя ошибка: ' + (e && e.message ? e.message : e) } });
  }
};
