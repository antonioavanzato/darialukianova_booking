/**
 * =====================================================================
 * Ретранслятор Instagram ↔ Yandex Cloud на Google Apps Script
 * ---------------------------------------------------------------------
 * graph.instagram.com недоступен из российских дата-центров, а вебхуки
 * Meta не доходят до адреса в Яндекс.Облаке. Тот же приём, что уже
 * используется в системе записи для api.telegram.org: между ними ставится
 * скрипт Google, которому доступны обе стороны.
 *
 * Два направления:
 *   Instagram → этот скрипт → функция daria-ig-bot   (входящие комментарии)
 *   daria-ig-bot → этот скрипт → Instagram           (отправка сообщений)
 *
 * Установка:
 *   1. script.google.com → «Новый проект», имя daria-ig-relay
 *   2. Вставить этот файл целиком вместо содержимого Code.gs
 *   3. Заполнить три строки в блоке НАСТРОЙКИ ниже
 *   4. «Начать развёртывание» → «Новое развёртывание» → тип «Веб-приложение»
 *      Выполнять от имени: «Я»
 *      У кого есть доступ: «Все» (обязательно, иначе Meta не достучится)
 *   5. Скопировать URL вида https://script.google.com/macros/s/…/exec
 *      · вписать его в Meta → Webhooks как Callback URL
 *      · вписать его же в переменную IG_RELAY_URL функции daria-ig-bot
 * =====================================================================
 */

/* ---------- НАСТРОЙКИ ---------- */

// Та же строка, что в переменной IG_VERIFY_TOKEN функции daria-ig-bot.
var VERIFY_TOKEN = 'daria-ig-2026-noty';

// Общий пароль между ботом и ретранслятором: придумать любую длинную строку
// и вписать её же в переменную IG_RELAY_SECRET функции daria-ig-bot.
// Нужен, чтобы адресом скрипта не мог воспользоваться посторонний.
var RELAY_SECRET = 'ПРИДУМАТЬ-ДЛИННУЮ-СТРОКУ';

// Адрес вебхука бота в Яндекс.Облаке (шлюз daria-ig-gw).
var YC_WEBHOOK_URL = 'https://d5dilpavgcrbi4n9l3au.g4vq2kuy.apigw.yandexcloud.net/api/ig/webhook';

var GRAPH_BASE = 'https://graph.instagram.com';

/* ---------- проверка подписки от Meta ---------- */
// Meta один раз дёргает адрес методом GET и ждёт обратно hub.challenge.
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p['hub.mode'] === 'subscribe' && p['hub.verify_token'] === VERIFY_TOKEN) {
    return ContentService.createTextOutput(String(p['hub.challenge'] || ''));
  }
  return ContentService.createTextOutput('ok');
}

/* ---------- оба направления ---------- */
function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  var data = {};
  try { data = JSON.parse(raw); } catch (err) { /* не-JSON тело */ }

  // Направление «бот → Instagram».
  if (data && data.secret && (data.method || data.op)) {
    if (data.secret !== RELAY_SECRET) {
      return json({ relayError: 'Неверный пароль ретранслятора' });
    }
    // Ответ на комментарий целиком: личное сообщение и публичный ответ за один
    // заход. Так бот ждёт ретранслятор один раз, а не два — иначе обработка
    // не укладывается в таймаут функции.
    if (data.op === 'reply') return json(replyToComment(data));
    return json(callInstagram(data.method, data.path, data.payload));
  }

  // Иначе это вебхук от Instagram — просто передаём его боту как есть.
  try {
    UrlFetchApp.fetch(YC_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: raw,
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.error('Не удалось передать вебхук боту: ' + err);
  }
  // Meta ждёт быстрый ответ, содержимое ей неважно.
  return ContentService.createTextOutput('EVENT_RECEIVED');
}

// Личное сообщение автору комментария плюс, если задан, публичный ответ.
// Публичный ответ необязателен: его неудача не отменяет отправленную личку.
function replyToComment(data) {
  var qs = '?access_token=' + encodeURIComponent(data.accessToken);
  var dm = callInstagram('POST',
    '/' + data.version + '/' + encodeURIComponent(data.igUserId) + '/messages' + qs,
    { recipient: { comment_id: data.commentId }, message: { text: data.dmText } });
  if (dm && (dm.error || dm.relayError)) return dm;

  var out = { dm: dm };
  if (data.publicText) {
    var pub = callInstagram('POST',
      '/' + data.version + '/' + encodeURIComponent(data.commentId) + '/replies' + qs,
      { message: data.publicText });
    if (pub && (pub.error || pub.relayError)) {
      console.warn('Публичный ответ не отправлен: ' + JSON.stringify(pub));
      out.publicFailed = true;
    } else {
      out.publicSent = true;
    }
  }
  return out;
}

// Вызов Instagram Graph API от имени скрипта.
function callInstagram(method, path, payload) {
  var options = {
    method: String(method || 'GET').toLowerCase(),
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  try {
    var res = UrlFetchApp.fetch(GRAPH_BASE + path, options);
    var text = res.getContentText();
    try { return JSON.parse(text); }
    catch (err) { return { relayError: 'Instagram вернул не-JSON: ' + text.slice(0, 300) }; }
  } catch (err) {
    return { relayError: String(err) };
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
