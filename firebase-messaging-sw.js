/* Service Worker для Firebase Cloud Messaging (фоновые push).
   ВАЖНО: файл ДОЛЖЕН называться именно firebase-messaging-sw.js и лежать в КОРНЕ сайта.
   ⬇ Впишите ТОТ ЖЕ FIREBASE_CONFIG, что и в index.html (поля messagingSenderId и appId обязательны). */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyC5ZzSnqXvA5p8b8NYjOPtRjHB2sDTkJmE",
  authDomain: "daria-booking-baae5.firebaseapp.com",
  projectId: "daria-booking-baae5",
  storageBucket: "daria-booking-baae5.firebasestorage.app",
  messagingSenderId: "486073637927",
  appId: "1:486073637927:web:c1d87f66a2ec50a3acc202"
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
