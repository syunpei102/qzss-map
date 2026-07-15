// QZSS災危通報マップ用Service Worker
// 地図の見た目(HTML/JS/CSS/スタイル定義/GeoJSON/アイコン)だけを
// オフラインでも開けるようキャッシュする。リアルタイム通信である
// WebSocketや /ingest への送信には一切関与しない(GET以外は素通し)。
const CACHE_VERSION = 'qzss-map-v4';
const APP_SHELL = [
  './',
  './index.html',
  './main.js',
  './style.css',
  './style.json',
  './manifest.json',
  './data/epicenter_regions.geojson',
  './data/tsunami_regions.geojson',
  './data/prefectures.geojson',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // GET以外(/ingestへのPOST等)やWebSocketは素通しする
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  // ネットワーク優先: このアプリは開発中で頻繁に更新されるため、
  // オンライン時は常に最新のファイルを使う。オフライン時のみ
  // キャッシュにフォールバックする(キャッシュ優先だと、更新後も
  // 古いmain.jsがブラウザに残り続けてしまうため)。
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ==================================================
// プッシュ通知
// サーバー(server.js)がweb-pushで送ってきたJSON({title, body})を
// 元に通知を表示する。JSONとして解釈できない場合は最低限の通知だけ出す。
// ==================================================
self.addEventListener('push', (event) => {
  let data = { title: '防災情報', body: '新しい通報が届きました。アプリを開いて確認してください。' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // JSONでなければデフォルト文言のまま表示する
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'qzss-alert', // 同時に複数出た場合に古い通知を上書きしすぎないよう、必要ならtagを外すことも検討
    })
  );
});

// 通知タップでアプリのタブを前面に出す(既に開いていればそれをフォーカス、
// 無ければ新規に開く)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
