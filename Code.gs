/**
 * =====================================================================
 * APPS SCRIPT — мост уведомлений для записи Дарьи Лукьяновой
 * ---------------------------------------------------------------------
 * Что делает: форма заявки шлёт сюда POST → этот скрипт:
 *   1) отправляет сообщение в Telegram-бот Даши;
 *   2) (опционально) шлёт push в PWA через FCM HTTP v1.
 *
 * НАСТРОЙКА (Project Settings → Script Properties), добавьте свойства:
 *   TELEGRAM_TOKEN   — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID — chat_id Даши (узнать: напишите боту, открыть
 *                      https://api.telegram.org/bot<TOKEN>/getUpdates )
 *   FIREBASE_PROJECT_ID — id проекта Firebase (для push; можно пропустить)
 *   SERVICE_ACCOUNT  — ВЕСЬ JSON сервис-аккаунта Firebase одной строкой
 *                      (Firebase → Настройки → Сервисные аккаунты →
 *                       Создать закрытый ключ). Нужен только для PWA-push.
 *
 * ДЕПЛОЙ: Deploy → New deployment → Web app →
 *   Execute as: Me,  Who has access: Anyone → скопировать URL в формы.
 * =====================================================================
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    sendTelegram(data);
    try { sendPush(data); } catch (err) { Logger.log('Push error: ' + err); }
    return json({ ok: true });
  } catch (err) {
    Logger.log('doPost error: ' + err);
    return json({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json({ ok: true, service: 'daria-booking-notifier' });
}

/* ---------------- TELEGRAM ---------------- */
function sendTelegram(d) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TELEGRAM_TOKEN');
  var chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) { Logger.log('Telegram не настроен'); return; }

  var text =
    '🎵 <b>Новая заявка</b>\n\n' +
    '👤 <b>' + esc(d.name) + '</b>\n' +
    '📞 ' + esc(d.phone || '—') + '\n' +
    (d.telegram ? '✈️ ' + esc(d.telegram) + '\n' : '') +
    '🎼 Направление: ' + esc(d.direction || '—') + '\n' +
    '📅 ' + esc(d.slotDate || '') + ' в ' + esc(d.slotTime || '') + '\n' +
    (d.comment ? '\n💬 ' + esc(d.comment) : '');

  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
    muteHttpExceptions: true
  });
}

/* ---------------- PWA PUSH (FCM HTTP v1) ---------------- */
function sendPush(d) {
  var props = PropertiesService.getScriptProperties();
  var saRaw = props.getProperty('SERVICE_ACCOUNT');
  var projectId = props.getProperty('FIREBASE_PROJECT_ID');
  if (!saRaw || !projectId) { Logger.log('FCM не настроен — пропускаю push'); return; }

  var sa = JSON.parse(saRaw);
  var accessToken = getAccessToken(sa);
  var tokens = getFcmTokens(projectId, accessToken);
  if (!tokens.length) { Logger.log('Нет сохранённых FCM-токенов'); return; }

  var title = 'Новая заявка: ' + (d.name || '');
  var body = (d.direction || '') + ' · ' + (d.slotDate || '') + ' ' + (d.slotTime || '');
  // ВАЖНО: link для webpush должен быть АБСОЛЮТНЫМ https-URL (адрес админки на GitHub Pages)
  var adminUrl = props.getProperty('ADMIN_URL') || 'https://antonioavanzato.github.io/darialukianova_booking/';

  tokens.forEach(function (tok) {
    var msg = {
      message: {
        token: tok,
        notification: { title: title, body: body },
        data: { id: String(d.id || ''), name: String(d.name || ''), direction: String(d.direction || '') },
        webpush: {
          notification: { title: title, body: body, icon: adminUrl + 'icons/icon-192.png' },
          fcmOptions: { link: adminUrl }
        }
      }
    };
    var res = UrlFetchApp.fetch(
      'https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + accessToken },
        payload: JSON.stringify(msg),
        muteHttpExceptions: true
      }
    );
    Logger.log('FCM ' + res.getResponseCode());
  });
}

/* читаем config/admin.fcmTokens из Firestore через REST */
function getFcmTokens(projectId, accessToken) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + projectId +
            '/databases/(default)/documents/config/admin';
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return [];
  var doc = JSON.parse(res.getContentText());
  var arr = doc && doc.fields && doc.fields.fcmTokens && doc.fields.fcmTokens.arrayValue;
  if (!arr || !arr.values) return [];
  return arr.values.map(function (v) { return v.stringValue; }).filter(Boolean);
}

/* OAuth access token из сервис-аккаунта (JWT → token) */
function getAccessToken(sa) {
  var now = Math.floor(Date.now() / 1000);
  var header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  var signatureInput = header + '.' + claim;
  var signature = Utilities.computeRsaSha256Signature(signatureInput, sa.private_key);
  var jwt = signatureInput + '.' + base64url(signature);

  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  return JSON.parse(res.getContentText()).access_token;
}

/* ---------------- утилиты ---------------- */
function base64url(input) {
  var bytes = (typeof input === 'string') ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
