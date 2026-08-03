// QZSS災危通報マップ用Service Worker
// 地図の見た目(HTML/JS/CSS/スタイル定義/GeoJSON/アイコン)だけを
// オフラインでも開けるようキャッシュする。リアルタイム通信である
// WebSocketや /ingest への送信には一切関与しない(GET以外は素通し)。
const CACHE_VERSION = 'qzss-map-v5';

// インストール時に必ず事前キャッシュしておくファイル。以前はmaplibre-gl・
// pmtilesのライブラリ本体やほとんどのgeojsonデータが含まれておらず、
// 「見た目だけはオフラインでも開ける」はずが実際には地図ライブラリごと
// 無く地図が描画できない状態だった。municipalities.geojson(約1.9MB、
// 市区町村指定のLアラート用)だけは容量が大きくオンデマンド運用の方針
// (main.js側)に合わせ、ここでは強制先読みせず後述のランタイム
// キャッシュ対象にとどめる
const APP_SHELL = [
  './',
  './index.html',
  './main.js',
  './style.css',
  './style.json',
  './manifest.json',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/pmtiles.js',
  './data/epicenter_regions.geojson',
  './data/tsunami_regions.geojson',
  './data/prefectures.geojson',
  './data/weather_regions.geojson',
  './data/flood_rivers.geojson',
  './data/volcanoes.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// デプロイのたびに変わりうるファイル(HTML/JS/CSS本体)以外は、
// キャッシュ優先+裏で更新確認(stale-while-revalidate)にする。
// vendorライブラリ・style.json・地理データはほぼ変化しないため、
// 毎回ネットワーク往復を待たせる必要が無い(即キャッシュから返しつつ、
// 裏で最新版を取得して次回に備える)
const CACHE_FIRST_PATHS = new Set([
  '/style.json',
  '/vendor/maplibre-gl.js',
  '/vendor/maplibre-gl.css',
  '/vendor/pmtiles.js',
  '/data/epicenter_regions.geojson',
  '/data/tsunami_regions.geojson',
  '/data/prefectures.geojson',
  '/data/weather_regions.geojson',
  '/data/flood_rivers.geojson',
  '/data/volcanoes.json',
  '/data/municipalities.geojson',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]);

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

// レスポンスをキャッシュへ保存してよいか。Cache APIの仕様上、Range
// リクエストへの206 Partial Contentはcache.put()できず例外になる
// (pmtiles.jsはbase_slim_final.pmtilesの取得に常にRangeヘッダーを使う
// ため、ここで弾かないと毎回コンソールにエラーが出ていた)
function isCacheable(response) {
  return response.ok && response.status !== 206;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // GET以外(/ingestへのPOST等)やWebSocketは素通しする
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  // pmtiles本体はRangeリクエストで部分取得されるため、Cache APIでは
  // 正しく扱えない(上記isCacheable参照)。キャッシュ層には関与せず
  // 常にそのままネットワークへ通す(HTTPの通常のブラウザキャッシュに
  // 任せる。server.js側で/dataに1日のCache-Controlを付与済み)
  if (request.headers.has('range')) {
    event.respondWith(fetch(request));
    return;
  }

  const { pathname } = new URL(request.url);

  if (CACHE_FIRST_PATHS.has(pathname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((response) => {
              if (isCacheable(response)) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // それ以外(index.html/main.js/style.css等、更新頻度が高いファイル)は
  // ネットワーク優先。オンライン時は常に最新のファイルを使い、オフライン
  // 時のみキャッシュにフォールバックする(キャッシュ優先だと、更新後も
  // 古いmain.jsがブラウザに残り続けてしまうため)
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (isCacheable(response)) {
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
