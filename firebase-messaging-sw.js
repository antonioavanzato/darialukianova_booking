/* Service Worker для Firebase Cloud Messaging (фоновые push).
   ВАЖНО: файл ДОЛЖЕН называться именно firebase-messaging-sw.js и лежать в КОРНЕ сайта.
   ⬇ Впишите ТОТ ЖЕ FIREBASE_CONFIG, что и в index.html (поля messagingSenderId и appId обязательны). */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "ВСТАВЬТЕ_apiKey",
  authDomain: "ВСТАВЬТЕ.firebaseapp.com",
  projectId: "ВСТАВЬТЕ_projectId",
  storageBucket: "ВСТАВЬТЕ.appspot.com",
  messagingSenderId: "ВСТАВЬТЕ",
  appId: "ВСТАВЬТЕ_appId"
});

const messaging = firebase.messaging();

// Фоновое уведомление (когда PWA закрыта/свёрнута)
messaging.onBackgroundMessage((payload) => {
  const n = (payload && payload.notification) || {};
  const data = (payload && payload.data) || {};
  self.registration.showNotification(n.title || "Новая заявка", {
    body: n.body || (data.name ? data.name + " — " + (data.direction || "") : "Открыть админку"),
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    vibrate: [120, 60, 120],
    tag: "booking-" + (data.id || Date.now()),
    data: data
  });
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});
