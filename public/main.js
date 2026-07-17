// ラズパイ本体のkiosk表示(localhostでアクセス)では、操作する人が
// その場にいない前提(マウス・タッチ操作は一切無い)。通知ボタンの
// 非表示だけでなく、地図の操作ハンドラ自体を無効化する判定にも使う
const IS_LOCAL_KIOSK = ['localhost', '127.0.0.1'].includes(location.hostname);

// ==================================================
// 時計表示
// ==================================================
function get_time() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  document.getElementById('now_time').textContent = `${h}:${m}:${s}`;
}
setInterval(get_time, 1000);
get_time();

function nowTimeString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ==================================================
// オンライン・オフライン判定
// ==================================================
// 時計横のピルは2つの状態を合わせて表示する:
// 1. ブラウザ⇔サーバーのWebSocket接続(wsState)
// 2. 現地の受信機(ラズパイ/PC + アンテナ)からのハートビート
//    (read_legacy.py が30秒おきに送ってくる。45秒途絶えたらオフライン扱い)
// ハートビートが一度も来ていない場合はWebSocket接続の状態だけで判定する
// (ローカルのテストデータのみで使う場合など、受信機を使わない用途に配慮)
const HEARTBEAT_TIMEOUT_MS = 45000;
let wsState = 'offline'; // 'online' | 'reconnecting' | 'offline'
let lastHeartbeatTime = null;

function updateConnectionStatus(state) {
  wsState = state;
  refreshStatusPill();
}

// 直近に実際の通報(DCR/DCX)を送ってきた衛星。ハートビートには衛星情報が
// 無いため、オンライン/オフライン判定とは別に、通報を受信するたびに更新する。
// 「今どの衛星が日本上空にいるか」ではなく「最後に受信した通報がどの衛星
// からのものだったか」を表示する(該当カテゴリの通報が来ない限り更新
// されないので、その場合は受信時刻が古いままになる=それ自体が情報になる)
let lastSatelliteInfo = null; // { satelliteId, satellitePrn, receivedAt }

function noteSatelliteReceived(report) {
  if (typeof report.satellite_id !== 'number') return;
  lastSatelliteInfo = {
    satelliteId: report.satellite_id,
    satellitePrn: report.satellite_prn,
    receivedAt: Date.now(),
  };
  refreshStatusPill();
}

function refreshStatusPill() {
  const statusEl = document.getElementById('status');
  const satelliteEl = document.getElementById('satellite_info');
  if (wsState === 'reconnecting') {
    statusEl.textContent = '🟡 再接続中';
    statusEl.className = 'status-pill status-reconnecting';
    if (satelliteEl) satelliteEl.textContent = '';
    return;
  }
  if (wsState === 'offline') {
    statusEl.textContent = '🔴 オフライン';
    statusEl.className = 'status-pill status-offline';
    if (satelliteEl) satelliteEl.textContent = '';
    return;
  }
  // wsState === 'online' の場合、ハートビートの途絶もオフライン扱いにする
  if (lastHeartbeatTime !== null && Date.now() - lastHeartbeatTime > HEARTBEAT_TIMEOUT_MS) {
    if (statusEl.textContent !== '🔴 オフライン') {
      const sec = Math.round((Date.now() - lastHeartbeatTime) / 1000);
      console.log(`🔴 ハートビート途絶によりオフライン表示に切り替え(最終受信から${sec}秒経過、閾値${HEARTBEAT_TIMEOUT_MS / 1000}秒)`);
    }
    statusEl.textContent = '🔴 オフライン';
    statusEl.className = 'status-pill status-offline';
    if (satelliteEl) satelliteEl.textContent = '';
    return;
  }
  if (statusEl.textContent !== '🟢 オンライン' && lastHeartbeatTime !== null) {
    console.log(`🟢 ハートビート受信によりオンライン表示に復帰: ${nowTimeString()}`);
  }
  statusEl.textContent = '🟢 オンライン';
  statusEl.className = 'status-pill status-online';
  if (satelliteEl) {
    if (lastSatelliteInfo) {
      const name = SATELLITE_NAMES[lastSatelliteInfo.satelliteId] || `PRN${lastSatelliteInfo.satellitePrn}`;
      const time = new Date(lastSatelliteInfo.receivedAt);
      const pad = (n) => String(n).padStart(2, '0');
      satelliteEl.textContent = `🛰️ ${name}から最終受信 ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
    } else {
      satelliteEl.textContent = '🛰️ まだ通報を受信していません';
    }
  }
}
setInterval(refreshStatusPill, 5000);

// ==================================================
// 表示する通報の種類を絞り込む
// (緊急地震速報・震源・震度速報・津波関連のみ画面を更新する。
//  それ以外の種別は受信はするが、画面はそのまま保つ)
// ==================================================
const ALLOWED_CATEGORIES = new Set([1, 2, 3, 5]); // EEW, 震源, 震度, 津波

// 衛星から実際に配信される公式の訓練/試験放送(report_classification_no
// ===7、月2回程度)を地図・パネルに表示するかどうか。trueにすると本物の
// 警報と全く同じズーム・塗りつぶし・パネル表示を行うが、バッジ・
// タイトルに「[訓練]」を付与して見分けられるようにする(severityClass
// が既にsev-training色を返す)。
// サーバー側(GCS/ローカルファイルに永続化、Discordの
// /set_training_broadcasts で変更)から起動時に取得する。取得できる
// までの既定値・取得失敗時のフォールバックはtrue(従来通り表示する)
let showTrainingBroadcasts = true;
async function loadShowTrainingBroadcastsSetting() {
  try {
    const url = LOCKED_DEVICE_ID ? `/config?device=${encodeURIComponent(LOCKED_DEVICE_ID)}` : '/config';
    const res = await fetch(url);
    const data = await res.json();
    if (typeof data.showTrainingBroadcasts === 'boolean') showTrainingBroadcasts = data.showTrainingBroadcasts;
  } catch (err) {
    console.warn('訓練放送表示設定の取得に失敗しました(既定値のまま続行):', err);
  }
}

// 震度速報の震度コード(1〜7) -> 表示ラベル/色
// 彩度を抑えた単一の暖色グラデーション(穏やかな青→黄土→橙→赤→深いえんじ色)にして、
// ダークな地図/UIの中で浮かないよう、また階調が自然につながるようにしている
const SEISMIC_INTENSITY_LABELS = {
  1: '4未満', 2: '4', 3: '5弱', 4: '5強', 5: '6弱', 6: '6強', 7: '7',
};
const SEISMIC_INTENSITY_COLORS = {
  1: '#7ea6c4', // 4未満
  2: '#dbb85c', // 震度4
  3: '#d99a45', // 震度5弱
  4: '#c97a3f', // 震度5強
  5: '#b2543f', // 震度6弱
  6: '#8f3636', // 震度6強
  7: '#5c2a4d', // 震度7
};
const SEISMIC_INTENSITY_TEXT_COLORS = {
  1: '#111', 2: '#111', 3: '#111', 4: '#fff', 5: '#fff', 6: '#fff', 7: '#fff',
};

// 津波警報コード -> 表示色
const TSUNAMI_COLORS = {
  4: '#c800c8', // 大津波警報
  5: '#c800c8', // 大津波警報：発表
  3: '#ff2800', // 津波警報
  15: '#ff9900', // その他の警報
  1: '#8c8c8c', // 津波なし
  2: '#8c8c8c', // 警報解除
};
const TSUNAMI_DEFAULT_COLOR = '#00a0e9';

// 通報のsatellite_id (= PRNの下位6bit) -> みちびき衛星の号機名
// L1S信号の公式PRN割当 (IS-QZSS-L1S / IS-QZSS-DCX-004 Table 5.6-3) に準拠:
//   PRN183=QZS-1(初号機), 184=QZS-2(2号機), 185=QZS-4(4号機),
//   186=QZS-1R(初号機後継機), 189=QZS-3(3号機)
// ※185=4号機/189=3号機。DCR同人誌の対応表は185↔189が逆だったため注意。
const SATELLITE_NAMES = {
  55: 'みちびき初号機',       // PRN183 = QZS-1 (運用終了済み)
  56: 'みちびき2号機',       // PRN184 = QZS-2
  57: 'みちびき4号機',       // PRN185 = QZS-4
  58: 'みちびき初号機後継機', // PRN186 = QZS-1R
  61: 'みちびき3号機',       // PRN189 = QZS-3
};

// 緊急地震速報の「予報区コード」(71種、azarashiのqzss_dcr_jma_eew_forecast_region)
// -> 都道府県ID(prefectures.geojsonのid、1〜47)。
// 地方単位(中国・四国・九州など)は構成する都道府県すべてに展開する。
const EEW_REGION_TO_PREFECTURE_IDS = {
  1: [1], 2: [1], 3: [1], 4: [1], // 北海道各地域
  5: [2], 6: [3], 7: [4], 8: [5], 9: [6], 10: [7],
  11: [8], 12: [9], 13: [10], 14: [11], 15: [12], 16: [13],
  17: [13], 18: [13], // 伊豆諸島・小笠原 -> 東京都
  19: [14], 20: [15], 21: [16], 22: [17], 23: [18], 24: [19],
  25: [20], 26: [21], 27: [22], 28: [23], 29: [24], 30: [25],
  31: [26], 32: [27], 33: [28], 34: [29], 35: [30], 36: [31],
  37: [32], 38: [33], 39: [34], 40: [35], 41: [36], 42: [37],
  43: [38], 44: [39], 45: [40], 46: [41], 47: [42], 48: [43],
  49: [44], 50: [45], 51: [46],
  52: [46], // 奄美(群島) -> 鹿児島県
  53: [47], 54: [47], 55: [47], 56: [47], // 沖縄本島・大東島・宮古島・八重山
  57: [1], // 北海道(全域)
  58: [2, 3, 4, 5, 6, 7], // 東北
  59: [8, 9, 10, 11, 12, 13, 14], // 関東
  60: [13], 61: [13], // 伊豆諸島・小笠原
  62: [15, 16, 17, 18], // 北陸
  63: [19, 20], // 甲信
  64: [21, 22, 23, 24], // 東海
  65: [25, 26, 27, 28, 29, 30], // 近畿
  66: [31, 32, 33, 34, 35], // 中国
  67: [36, 37, 38, 39], // 四国
  68: [40, 41, 42, 43, 44, 45, 46], // 九州
  69: [46], // 奄美(群島)
  70: [47], // 沖縄
  // 80: その他の府県予報区および地方予報区 -> 対応なし
};

// ==================================================
// 座標計算まわりの小さなユーティリティ
// (精密なGISライブラリではなく、地図上にざっくり
//  マーカー/ハイライトを置くための簡易実装)
// ==================================================
function eachCoordinate(coords, cb) {
  if (typeof coords[0] === 'number') {
    cb(coords);
    return;
  }
  for (const c of coords) eachCoordinate(c, cb);
}

function geometryBounds(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  eachCoordinate(geometry.coordinates, ([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  return [minX, minY, maxX, maxY];
}

// 都道府県ジオメトリの「主要な陸地」だけでズーム範囲を決める。
// 東京都(小笠原諸島)や鹿児島県(奄美群島)のように、本土から大きく
// 離れた属島を含む都道府県だと、単純な座標の最小・最大(bounding box)
// では離島に引っ張られて中心が本土から大きくズレてしまう(例: 東京都
// 単体だと中心が父島沖になり、本土が画面外になってしまう)。
// MultiPolygonの場合は、bbox面積が最大のポリゴン(=本土)だけを使う
function mainLandBounds(geometry) {
  if (geometry.type !== 'MultiPolygon') return geometryBounds(geometry);
  let best = null;
  let bestArea = -1;
  for (const rings of geometry.coordinates) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    eachCoordinate(rings, ([x, y]) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    });
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) {
      bestArea = area;
      best = [minX, minY, maxX, maxY];
    }
  }
  return best || geometryBounds(geometry);
}

function geometryCentroid(geometry) {
  let sumX = 0, sumY = 0, n = 0;
  eachCoordinate(geometry.coordinates, ([x, y]) => {
    sumX += x; sumY += y; n++;
  });
  return n ? [sumX / n, sumY / n] : null;
}

function unionBounds(boundsList) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [a, b, c, d] of boundsList) {
    if (a < minX) minX = a;
    if (b < minY) minY = b;
    if (c > maxX) maxX = c;
    if (d > maxY) maxY = d;
  }
  return [minX, minY, maxX, maxY];
}

// 気象庁の 度分秒(+南緯/西経フラグ) を10進度に変換する
// (QzssDcReportJmaHypocenter の coordinates_of_hypocenter 形式)
function dmsToDecimal({ d, m, s, negative }) {
  const value = d + m / 60 + s / 3600;
  return negative ? -value : value;
}

// Lアラート(CAP準拠)の楕円形対象範囲を描画するためのポリゴン生成。
// 中心緯度経度・長半径/短半径(km)・方位角(度、北を0とし東回り)から、
// 地表面をおおむね平面とみなした近似で楕円の頂点列を作る
// (数百km程度の範囲なら十分な精度)
function ellipsePolygon([lon, lat], semiMajorKm, semiMinorKm, azimuthDeg, points = 64) {
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.320 * Math.cos((lat * Math.PI) / 180);
  const coords = [];
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    // 楕円のローカル座標(x=長軸方向, y=短軸方向)
    const localX = semiMajorKm * Math.cos(theta);
    const localY = semiMinorKm * Math.sin(theta);
    // 方位角だけ回転(北=0度基準、時計回り)させてから緯度経度に変換
    const dx = localX * Math.sin(azimuthRad) + localY * Math.cos(azimuthRad);
    const dy = localX * Math.cos(azimuthRad) - localY * Math.sin(azimuthRad);
    coords.push([lon + dx / kmPerDegLon, lat + dy / kmPerDegLat]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeometry(pt, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polygons) {
    if (!pointInRing(pt, rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(pt, rings[h])) inHole = true;
    }
    if (!inHole) return true;
  }
  return false;
}

// Lアラートの楕円(市区町村単位ではない任意の範囲)が、参考としてどの
// 都道府県と重なっているかを大まかに調べる。楕円の中心と外周上の点を
// 都道府県ポリゴンに対して点内判定するだけの近似(市区町村の厳密な
// 特定はできないが、大まかな場所のイメージを伝えるには十分)
function findOverlappingPrefectureNames(ellipsePoly) {
  const names = new Set();
  for (const [lon, lat] of ellipsePoly.coordinates[0]) {
    for (const feature of prefectureFeaturesById.values()) {
      if (pointInPolygonGeometry([lon, lat], feature.geometry)) {
        names.add(feature.properties.name);
        break;
      }
    }
  }
  return [...names];
}

// ==================================================
// 地図まわり
// ==================================================
let map;
let epicenterFeaturesById = new Map();
let tsunamiFeaturesByCode = new Map();
let prefectureFeaturesById = new Map();
let prefectureFeaturesByName = new Map();
let municipalityFeaturesByCode = new Map();
let weatherFeaturesByCode = new Map();

// 左上に情報パネルが常時かぶさっているため、その分だけ
// 地図を右側に寄せてfitBoundsする(パネルの真下に対象が
// 隠れて「表示されていないように見える」のを防ぐ)
// スマホ幅ではパネルが上部に幅いっぱいで表示されるため、
// 左ではなく上方向にパディングを寄せる(style.cssのメディア
// クエリと同じ700pxを境目にする)
const PANEL_LEFT_PADDING = 370;
const MOBILE_BREAKPOINT = 700;

function isMobileLayout() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

// スマホ版はパネルの高さが中身(バナーの有無など)によって変わるため、
// 固定値ではなく実際に描画されているパネルの高さを毎回測って使う
// (津波警報バナーなどでパネルが伸びた時に、地図の対象地域が
//  パネルの下に隠れてしまうのを防ぐため)
function getMobileTopPadding() {
  const panel = document.querySelector('.panel');
  if (!panel) return 130;
  return panel.getBoundingClientRect().height + 16;
}

// 地図で実際に表示している範囲(mapのmaxBoundsと合わせる)。
// 海外で地震が起きた場合など、震源の座標が日本からかけ離れていると
// そのままfitBoundsしてしまい、日本地図がほとんど映らない
// 「変な場所」にズームしてしまう。表示範囲と交差する部分だけに
// 切り詰め、完全に範囲外(交差なし)ならズームしない(今の表示を維持する)
const JAPAN_VICINITY_BOUNDS = [100.0, 15.0, 170.0, 55.0];

function clampBoundsToJapanVicinity(bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  const [jMinX, jMinY, jMaxX, jMaxY] = JAPAN_VICINITY_BOUNDS;
  const clamped = [Math.max(minX, jMinX), Math.max(minY, jMinY), Math.min(maxX, jMaxX), Math.min(maxY, jMaxY)];
  if (clamped[0] > clamped[2] || clamped[1] > clamped[3]) return null;
  return clamped;
}

// 市区町村(Lアラート)のように対象範囲が小さい場合、通常の上限(9)の
// ままだと国土地理院タイルの詳細が見える程度の粗いズームにしかならず、
// 塗りつぶし範囲が豆粒のようにしか見えない。対象範囲の対角線が十分
// 小さい(≒市区町村・楕円スケール)場合だけ、もう少し寄れるようにする。
// 震源座標のみのように面積ゼロの「点」は対象外(従来通り9のまま。
// 点を上限いっぱいまでズームするのは意味がない)
function maxZoomForBounds(bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  return diagonal > 0 && diagonal < 0.6 ? 11 : 9;
}

function flyToBounds(bounds, pad = 24, maxZoomOverride = null, instant = false) {
  if (!isFinite(bounds[0])) return;
  const clamped = clampBoundsToJapanVicinity(bounds);
  if (!clamped) return;
  bounds = clamped;
  const rawPadding = isMobileLayout()
    ? { top: pad + 20 + getMobileTopPadding(), bottom: pad + 20, left: pad + 20, right: pad + 20 }
    : { top: pad + 20, bottom: pad + 20, left: pad + PANEL_LEFT_PADDING, right: pad + 20 };
  // PANEL_LEFT_PADDING等は通常のPC/スマホ画面を前提にした固定値のため、
  // Kiosk用の小さい画面(例: 800x480)だとパディングだけで画面の半分近くを
  // 占めてしまい、地図がほぼ画面外に押し出されて「表示されていないように
  // 見える」ことがあった。パディングが画面サイズに対して大きくなりすぎない
  // よう、コンテナサイズの一定割合を上限にクランプする
  const container = map.getContainer();
  const maxHorizontal = container.clientWidth * 0.35;
  const maxVertical = container.clientHeight * 0.35;
  const padding = {
    top: Math.min(rawPadding.top, maxVertical),
    bottom: Math.min(rawPadding.bottom, maxVertical),
    left: Math.min(rawPadding.left, maxHorizontal),
    right: Math.min(rawPadding.right, maxHorizontal),
  };
  map.fitBounds(
    [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
    {
      padding,
      maxZoom: maxZoomOverride ?? maxZoomForBounds(bounds),
      // 気象警報の巡回や、全て収束して日本全体表示に戻すだけの場合は
      // 急いで見せる必要が無いので、アニメーションさせず(=毎フレームの
      // 計算が発生しない)瞬時に切り替える方が非力な端末には軽い。
      // 新規の地震・津波等、注目を引きたい場面だけアニメーションさせる
      duration: instant ? 0 : 800,
    }
  );
}

function createCrossMarkerElement() {
  const el = document.createElement('div');
  el.className = 'cross-marker';
  return el;
}

// マーカー本体(wrapper)にはMapLibreが位置決め用のtransformを
// 適用するため、拡大縮小は中の.intensity-badgeに対して別途行う
// (wrapper自体のtransformを上書きすると位置がずれてしまうため)
function createIntensityBadgeElement(label, color, textColor) {
  const wrapper = document.createElement('div');
  wrapper.className = 'intensity-badge-wrapper';
  const badge = document.createElement('div');
  badge.className = 'intensity-badge';
  badge.style.background = color;
  badge.style.color = textColor || '#111';
  badge.textContent = label;
  wrapper.appendChild(badge);
  return wrapper;
}

// ズームレベルに応じて震度バッジの大きさを変える
// (zoom6を基準サイズとし、拡大するほど大きく、縮小するほど小さくする)
const INTENSITY_BADGE_BASE_ZOOM = 6;
function intensityBadgeScaleForZoom(zoom) {
  return Math.min(2.2, Math.max(0.6, 1 + (zoom - INTENSITY_BADGE_BASE_ZOOM) * 0.22));
}
function applyIntensityBadgeScale(marker, scale) {
  const badge = marker.getElement().querySelector('.intensity-badge');
  if (badge) badge.style.transform = `scale(${scale})`;
}
function updateAllIntensityBadgeScales() {
  if (!map) return;
  const scale = intensityBadgeScaleForZoom(map.getZoom());
  for (const record of activeEvents.values()) {
    for (const marker of record.markers.intensityBadges) applyIntensityBadgeScale(marker, scale);
  }
}

// ==================================================
// パネル表示用のテキスト整形
// (azarashiの全項目をそのまま出すと文量が多すぎるため、
//  種別ごとに「重要そうな項目」だけへ絞り込む)
// ==================================================
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function summarizeList(list) {
  return list.join('、');
}

function severityClass(report) {
  if (report.type === 'DecodeError') return 'sev-error';
  if (report.report_classification_no === 7) return 'sev-training';

  const cat = report.disaster_category_no;
  if (cat === 1) return 'sev-emergency'; // 緊急地震速報
  if (cat === 5) { // 津波
    if ([4, 5].includes(report.tsunami_warning_code_raw)) return 'sev-emergency';
    if (report.tsunami_warning_code_raw === 3) return 'sev-warning';
    return 'sev-caution';
  }
  if (cat === 2 || cat === 3) return 'sev-warning'; // 震源・震度
  return 'sev-info';
}

// カード左端の色帯用。複数の通報が1枚に統合されている場合(緊急地震速報+
// 震度+津波など)は、その中で最も緊急度が高いものの色を使う
const SEVERITY_RANK = {
  'sev-emergency': 4,
  'sev-warning': 3,
  'sev-caution': 2,
  'sev-info': 1,
  'sev-training': 0,
  'sev-error': 0,
  'sev-cancel': -1,
  'sev-resolved': -1,
};

function cardSeverityClass(badges) {
  let best = 'sev-info';
  let bestRank = -Infinity;
  for (const b of badges) {
    const cls = (b.class || '').split(' ').find((c) => c.startsWith('sev-'));
    const rank = SEVERITY_RANK[cls] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = cls;
    }
  }
  return best;
}

function buildTitle(report) {
  if (report.tsunami_warning_code) return report.tsunami_warning_code;
  const base = report.information_type && report.information_type !== '発表'
    ? `${report.disaster_category}(${report.information_type})`
    : (report.disaster_category || report.type);
  // 国内の対象地域が無い(=海外や日本から遠く離れた場所の)地震は、
  // 国内向けの警報・注意報と紛らわしくないよう見出しで区別する
  if (isForeignOrDistantEarthquake(report)) return `${base}(海外)`;
  return base;
}

function buildSummary(report) {
  const rows = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, v]); };

  push('発表時刻', formatDateTime(report.report_time));

  if (report.seismic_epicenter) push('震央', report.seismic_epicenter);
  if (report.magnitude) push('マグニチュード', `M${report.magnitude}`);
  if (report.depth_of_hypocenter) push('深さ', report.depth_of_hypocenter);

  if (report.seismic_intensity_upper_limit) {
    const lower = report.seismic_intensity_lower_limit;
    const upper = report.seismic_intensity_upper_limit;
    push('震度', lower && lower !== upper ? `${lower}〜${upper}` : upper);
  }
  if (Array.isArray(report.seismic_intensities) && report.seismic_intensities.length) {
    const pref = Array.isArray(report.prefectures) ? report.prefectures[0] : '';
    push('最大震度', pref ? `震度${report.seismic_intensities[0]}(${pref})` : report.seismic_intensities[0]);
  }
  if (Array.isArray(report.eew_forecast_regions) && report.eew_forecast_regions.length) {
    push('対象地域', summarizeList(report.eew_forecast_regions));
  }
  if (Array.isArray(report.prefectures) && report.prefectures.length) {
    push('対象', summarizeList(report.prefectures));
  }

  if (Array.isArray(report.tsunami_forecast_regions) && report.tsunami_forecast_regions.length) {
    push('対象沿岸', summarizeList(report.tsunami_forecast_regions));
  }
  if (Array.isArray(report.tsunami_heights) && report.tsunami_heights.length) {
    push('津波の高さ', summarizeList([...new Set(report.tsunami_heights)]));
  }

  // 「強い揺れに警戒してください。」等、JMAが付加する定型の注意喚起文。
  // 震央・マグニチュード等の項目が既にあっても、安全に関わる重要な
  // 文言なので常に表示する(「なし」は情報が無いことを示すだけなので除外)
  if (Array.isArray(report.notifications_on_disaster_prevention) && report.notifications_on_disaster_prevention.length) {
    const messages = report.notifications_on_disaster_prevention.filter((m) => m && m !== 'なし');
    if (messages.length) push('お知らせ', messages.join(' '));
  }

  return rows;
}

// ==================================================
// Jアラート(DCX)専用の表示処理
// JMAのDCRレポートとはフィールド構成が全く異なるため別関数にする
// ==================================================
const JALERT_HAZARD_JA = {
  'Missile attack': 'ミサイル発射',
  'Air strike': '航空攻撃',
  'Guerrilla attack': 'ゲリラ・特殊部隊による攻撃',
  'Special forces attack': 'ゲリラ・特殊部隊による攻撃',
  'Terrorism': 'テロ',
  'Chemical attack': '化学攻撃',
  'Attack with nuclear weapons': '核攻撃',
  'Earthquake': '地震',
  'Tsunami': '津波',
  'Volcano eruption': '火山噴火',
  'Safety warning': '安全に関する警告(訓練/試験を含む)',
};

const JALERT_SEVERITY_COLOR = {
  'Extreme': '#b3261e',
  'Severe': '#d9822b',
  'Moderate': '#d0b400',
  'Unknown': '#7a4fd1',
};

function jalertSeverityKey(report) {
  const s = report.a5_severity || '';
  if (s.startsWith('Extreme')) return 'Extreme';
  if (s.startsWith('Severe')) return 'Severe';
  if (s.startsWith('Moderate')) return 'Moderate';
  return 'Unknown';
}

// CAP標準の深刻度(a5_severity)は英語の説明文でしか届かないため、
// パネル表示用に日本語訳を用意する
const JALERT_SEVERITY_JA = {
  Extreme: '最高度',
  Severe: '警戒',
  Moderate: '注意',
  Unknown: '不明',
};

function jalertSeverityJa(report) {
  return JALERT_SEVERITY_JA[jalertSeverityKey(report)];
}

// CAP標準の継続時間(a8_hazard_duration)も英語の説明文でしか届かない
// (azarashiのqzss_dcx_camf_a8_hazard_duration定義で取りうる値は4種類のみ)
const HAZARD_DURATION_JA = {
  'Unknown': '不明',
  'Duration < 6H': '6時間未満',
  '6H <= Duration < 12H': '6〜12時間',
  '12H <= Duration < 24H': '12〜24時間',
};

function hazardDurationJa(text) {
  return HAZARD_DURATION_JA[text] || text;
}

function jalertSeverityClass(report) {
  const key = jalertSeverityKey(report);
  if (key === 'Extreme') return 'sev-emergency';
  if (key === 'Severe') return 'sev-warning';
  if (key === 'Moderate') return 'sev-caution';
  return 'sev-training'; // 訓練/試験メッセージが多いため
}

// Jアラートには震央コードのような通し番号が無いため、解除(All Clear)が
// どのアラートに対応するかは「災害種別+対象地域」の組み合わせで判定する
// (LアラートのlalertMatchKeyと同じ考え方)
function jalertMatchKey(report) {
  const hazard = report.a4_hazard_type || '';
  const areas = [...(report.ex9_target_area_list_ja || [])].sort().join(',');
  return `${hazard}|${areas}`;
}

function buildEventFromJAlert(report) {
  const hazardJa = JALERT_HAZARD_JA[report.a4_hazard_type] || report.a4_hazard_type || 'Jアラート';
  const areas = report.ex9_target_area_list_ja || [];
  const rows = [
    ['深刻度', jalertSeverityJa(report)],
    ['対象', summarizeList(areas)],
  ].filter(([, v]) => v);

  const geo = { hypocenter: null, tsunami: [], prefectures: [] };
  const boundsList = [];
  const color = JALERT_SEVERITY_COLOR[jalertSeverityKey(report)];
  // ミサイル発射等、対象地域が「全国」として一括で発表されることがある。
  // prefectures.geojsonには都道府県ごとの地物しか無く「全国」という
  // 地物は存在しないため、そのままではどこにも塗られず「対象地域なのに
  // 地図上には何も描画されない」ように見えてしまう。実質的に全都道府県が
  // 対象という意味なので、47都道府県すべてに展開する
  const targetNames = areas.includes('全国')
    ? [...prefectureFeaturesByName.keys()]
    : areas;
  for (const name of targetNames) {
    const feature = prefectureFeaturesByName.get(name);
    if (!feature) continue;
    // Jアラートは震度のような段階がないため、バッジ(label)は付けず塗りつぶしのみ
    geo.prefectures.push({ id: feature.properties.id, color, label: null, textColor: '#fff' });
    boundsList.push(mainLandBounds(feature.geometry));
  }

  return {
    isTestData: !!report.is_test_data,
    jalertKey: jalertMatchKey(report),
    satelliteId: report.satellite_id,
    satellitePrn: report.satellite_prn,
    badgeText: 'Jアラート',
    badgeClass: 'report-badge ' + jalertSeverityClass(report),
    title: report.a1_message_type === 'Test' ? `${hazardJa}(訓練)` : hazardJa,
    meta: `受信 ${nowTimeString()}`,
    rows,
    geo,
    bounds: boundsList.length ? unionBounds(boundsList) : null,
    // 都道府県単位の塗りつぶしは、小さい県だと対象範囲(bbox対角線)が
    // 短く判定され、Lアラートの市区町村向けの上限(11)が誤って適用されて
    // 寄りすぎてしまうことがあるため、県の形が分かる程度の上限に固定する
    boundsMaxZoom: 7.5,
  };
}

// Lアラート(地方公共団体からの災害情報)は180種類近いCAP標準の災害種別を
// 取りうるが、日本の市区町村が実際に発信するものはこの範囲にほぼ収まる。
// 未知の種別は英語のまま表示する(Jアラートと同じフォールバック方針)
const LALERT_HAZARD_JA = {
  'Earthquake': '地震',
  'Tsunami': '津波',
  'Tidal wave': '高波',
  'Flood': '洪水',
  'Coastal flooding': '高潮',
  'Rainfall': '大雨',
  'Debris flow': '土石流',
  'Landslide': '地すべり',
  'Crack in the ground / sinkhole': '地割れ・陥没',
  'Avalanche risk': '雪崩',
  'Snowdrifts': '吹きだまり',
  'Snow storm / blizzard': '暴風雪',
  'Snowfall': '大雪',
  'Volcano eruption': '火山噴火',
  'Ash fall': '降灰',
  'Lava flow': '溶岩流',
  'Pyroclastic flow': '火砕流',
  'Volcanic mud flow': '融雪型火山泥流',
  'Tornado': '竜巻',
  'Tropical cyclone (typhoon)': '台風',
  'Storm or thunderstorm': '暴風・雷',
  'Wind / wave / storm surge': '強風・高波・高潮',
  'Lightning': '雷',
  'Hail': 'ひょう',
  'Structure fire / Industrial fire': '火災',
  'Forest fire': '林野火災',
  'Building collapse': '建物倒壊',
  'Dam failure or bursting of a dam': 'ダム決壊',
  'Dike failure or bursting of a dike': '堤防決壊',
  'Life Threatening situation': '生命に関わる状況',
  'Safety warning': '安全に関する警告',
};

// LアラートにはJMAのDCRのような通し番号(震央コード等)が無いため、解除
// (All Clear)がどのアラートに対応するかは「災害種別+対象地域」の組み
// 合わせで判定する(同じ市区町村/同じ楕円中心に同じ種別の警報が2件同時に
// 出ることは想定しない前提の簡易な突き合わせ)
function lalertMatchKey(report) {
  const hazard = report.a4_hazard_type || '';
  if (report.ex1_target_area_code_raw != null) return `${hazard}|ex1:${report.ex1_target_area_code_raw}`;
  if (typeof report.a12_ellipse_centre_latitude === 'number') {
    return `${hazard}|ellipse:${report.a12_ellipse_centre_latitude.toFixed(2)},${report.a13_ellipse_centre_longitude.toFixed(2)}`;
  }
  return `${hazard}|unknown`;
}

function buildEventFromLAlert(report) {
  const hazardJa = LALERT_HAZARD_JA[report.a4_hazard_type] || report.a4_hazard_type || 'Lアラート';
  const color = JALERT_SEVERITY_COLOR[jalertSeverityKey(report)];
  const geo = { hypocenter: null, tsunami: [], prefectures: [] };
  const boundsList = [];
  const rows = [['深刻度', jalertSeverityJa(report)]];
  let pendingMunicipalityCode = null;

  // 対象範囲は「中心緯度経度+半径」の楕円(市区町村より精密な範囲)、または
  // 「対象地域名(市区町村)」のどちらか一方だけが入っている
  if (typeof report.a12_ellipse_centre_latitude === 'number' && typeof report.a13_ellipse_centre_longitude === 'number') {
    const center = [report.a13_ellipse_centre_longitude, report.a12_ellipse_centre_latitude];
    const major = report.a14_ellipse_semi_major_axis || 1;
    const minor = report.a15_ellipse_semi_minor_axis || major;
    const polygon = ellipsePolygon(center, major, minor, report.a16_ellipse_azimuth || 0);
    geo.ellipse = { polygon, color };
    boundsList.push(geometryBounds(polygon));
    rows.push(['対象範囲', `半径約${Math.round(major)}km圏内`]);
    // 楕円は市区町村単位に整列しない任意の範囲を表すための仕様なので、
    // 正確な行政区域ではなく「大まかな場所」の参考情報として都道府県名を添える
    const overlapping = findOverlappingPrefectureNames(polygon);
    if (overlapping.length) rows.push(['参考(重なる都道府県)', overlapping.join('・')]);
  } else if (report.ex1_target_area_ja) {
    rows.push(['対象地域', report.ex1_target_area_ja]);
    // ex1の市区町村コードは全国地方公共団体コード(JIS X0402、先頭0埋め
    // 5桁)そのものなので、国土数値情報(N03)の市区町村ポリゴンと直接
    // 対応付けられる。都道府県全体を塗ると「対象外の市区町村まで
    // 対象に見える」誤解を招くため、実際の市区町村単位でのみ塗る
    // (対応するポリゴンが無ければ地図には何も描かず、テキストのみ)
    if (typeof report.ex1_target_area_code_raw === 'number') {
      const code = String(report.ex1_target_area_code_raw).padStart(5, '0');
      const feature = municipalityFeaturesByCode.get(code);
      if (feature) {
        geo.municipality = { code, color };
        boundsList.push(geometryBounds(feature.geometry));
      } else {
        // 市区町村レイヤーは実際に必要になるまで読み込まない(オンデマンド)。
        // まだ読み込んでいなければここで読み込みを開始する
        // (loadMunicipalityLayerは多重呼び出し安全)。コードだけ覚えておき、
        // 読み込み完了後にloadMunicipalityLayer側で改めて塗りを反映する
        pendingMunicipalityCode = code;
        loadMunicipalityLayer();
      }
    }
  }

  if (report.a11_japanese_library_ja) rows.push(['指示', report.a11_japanese_library_ja]);
  if (report.a8_hazard_duration) rows.push(['継続時間', hazardDurationJa(report.a8_hazard_duration)]);

  return {
    isTestData: !!report.is_test_data,
    lalertKey: lalertMatchKey(report),
    satelliteId: report.satellite_id,
    satellitePrn: report.satellite_prn,
    badgeText: 'Lアラート',
    badgeClass: 'report-badge ' + jalertSeverityClass(report),
    title: report.a1_message_type === 'Test' ? `${hazardJa}(訓練)` : hazardJa,
    meta: `受信 ${nowTimeString()}`,
    rows: rows.filter(([, v]) => v),
    geo,
    bounds: boundsList.length ? unionBounds(boundsList) : null,
    pendingMunicipalityCode,
    lalertColor: color,
  };
}

// ==================================================
// 気象警報・注意報(disaster_category_no=10)・台風(12)・
// その他(南海トラフ4/火山8/降灰9/洪水11)の表示処理
// (JMAのDCRだが地震・津波とはフィールド構成が異なるため別関数にする)
//
// activeEvents(震央コード/発生時刻で1つの地震にまとめる仕組み)には
// 乗せず、専用のMapで管理する。理由: 気象警報は1通の通報に複数の
// 地域コードが同時に含まれ、しかも地域ごとに個別に解除されうるため、
// 「1通報=1イベント」を前提にした activeEvents の統合ロジックとは
// 相性が悪い。表示(地図のレイヤー・自動ズーム・パネル)は
// syncActiveEventLayers/updateCameraForActiveEvents/renderEventsPanel 側でactiveEventsと
// まとめて扱う。
// ==================================================
let weatherSites = new Map(); // key: 地域コード -> {code, name, subCategories:[...], bounds, ...}
let otherReports = new Map(); // key: disaster_category_no(4,8,9,11) -> {...}

const OTHER_CATEGORY_BADGE_CLASS = {
  4: 'sev-warning',  // 南海トラフ地震
  8: 'sev-warning',  // 火山
  9: 'sev-caution',  // 降灰
  11: 'sev-caution', // 洪水
};

function otherBadgeClassForReport(report) {
  if (report.report_classification_no === 7) return 'sev-training';
  return OTHER_CATEGORY_BADGE_CLASS[report.disaster_category_no] || 'sev-info';
}

// 気象(Dc=10)で配信されうる災害副種別は次の11種類のみ
// (IS-QZSS-DCR仕様 Table35 / azarashi の
//  qzss_dcr_jma_weather_related_disaster_sub_category に一致)。
// JMAの緊迫度に合わせて3段階に分類する
const WEATHER_SUB_CATEGORY_SEVERITY = {
  '暴風雪特別警報': 3,
  '大雨特別警報': 3,
  '暴風特別警報': 3,
  '大雪特別警報': 3,
  '波浪特別警報': 3,
  '高潮特別警報': 3,
  '全ての気象特別警報': 3,
  '土砂災害警戒情報': 2,
  '記録的短時間大雨情報': 2,
  'その他の警報等情報要素': 2,
  '竜巻注意情報': 1,
};

function weatherSeverityRank(name) {
  if (!name) return 0;
  if (name in WEATHER_SUB_CATEGORY_SEVERITY) return WEATHER_SUB_CATEGORY_SEVERITY[name];
  if (name.includes('特別警報')) return 3;
  if (name.includes('注意')) return 1;
  return 2;
}

function worstSubCategory(subCategories) {
  return [...subCategories].sort((a, b) => weatherSeverityRank(b) - weatherSeverityRank(a))[0];
}

function weatherSeverityBadgeClass(name) {
  const rank = weatherSeverityRank(name);
  if (rank === 3) return 'report-badge sev-tokubetsu';
  if (rank === 1) return 'report-badge sev-caution';
  return 'report-badge sev-keihou';
}

const WEATHER_WARNING_COLOR = '#e63946'; // 警報(既定・レベル2相当)
const WEATHER_SEVERITY_COLORS = { 3: '#8e24aa', 2: '#e63946', 1: '#d0b400' };

function weatherSeverityColor(subCategoryName) {
  return WEATHER_SEVERITY_COLORS[weatherSeverityRank(subCategoryName)] || WEATHER_WARNING_COLOR;
}

function regionDisplayName(code, rawName) {
  const prefId = Math.floor(code / 10000);
  const pref = prefectureFeaturesById.get(prefId);
  if (!pref) return rawName;
  const prefName = pref.properties.name;
  if (!rawName || rawName === prefName || rawName.startsWith(prefName)) return rawName || prefName;
  return `${prefName} ${rawName}`;
}

function buildEventFromOtherCategory(report) {
  const rows = [];
  // 洪水(11): 対象河川と警戒レベルをそれぞれの欄で表示する
  // (以前はdescriptionの1行目だけで、河川名が出ないことがあった)
  if (Array.isArray(report.flood_forecast_regions) && report.flood_forecast_regions.length) {
    rows.push(['対象河川', report.flood_forecast_regions.join('、')]);
  }
  if (Array.isArray(report.flood_warning_levels) && report.flood_warning_levels.length) {
    rows.push(['警戒レベル', [...new Set(report.flood_warning_levels)].join('、')]);
  }
  // 火山(8)・降灰(9): 火山名と警報種別
  if (report.volcano_name) rows.push(['火山', report.volcano_name]);
  if (report.volcanic_warning_code) rows.push(['警報', report.volcanic_warning_code]);
  if (Array.isArray(report.ash_fall_warning_codes) && report.ash_fall_warning_codes.length) {
    rows.push(['降灰', [...new Set(report.ash_fall_warning_codes)].join('、')]);
  }
  const firstLine = (report.description || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (firstLine) rows.push(['内容', firstLine]);
  return {
    isTestData: !!report.is_test_data,
    satelliteId: report.satellite_id,
    satellitePrn: report.satellite_prn,
    badgeText: report.disaster_category || report.type,
    badgeClass: otherBadgeClassForReport(report),
    title: report.disaster_category
      ? `${report.disaster_category}${report.information_type && report.information_type !== '発表' ? `(${report.information_type})` : ''}`
      : report.type,
    meta: `受信 ${nowTimeString()}`,
    rows,
    updatedAt: Date.now(),
  };
}

function updateWeatherDisplay() {
  if (!map || !map.getLayer('weather-fill')) return;
  const codes = [...weatherSites.keys()];
  if (!codes.length) {
    map.setFilter('weather-fill', ['in', ['get', 'code'], ['literal', []]]);
    map.setFilter('weather-outline', ['in', ['get', 'code'], ['literal', []]]);
    return;
  }
  map.setFilter('weather-fill', ['in', ['get', 'code'], ['literal', codes]]);
  map.setFilter('weather-outline', ['in', ['get', 'code'], ['literal', codes]]);
  const matchExpr = ['match', ['get', 'code']];
  for (const [code, site] of weatherSites) {
    matchExpr.push(code, weatherSeverityColor(worstSubCategory(site.subCategories)));
  }
  matchExpr.push(WEATHER_WARNING_COLOR);
  map.setPaintProperty('weather-fill', 'fill-color', matchExpr);
  map.setPaintProperty('weather-outline', 'line-color', matchExpr);
}

// 解除(取消)信号が届かないまま安全策のTTL(TTL_WEATHER_MS)が経過した
// 気象警報・注意報を消す。更新が来るたびにタイマーはリセットされるため、
// これが実際に発火するのは「その地域について何の続報も来なくなった」場合のみ
function expireWeatherSite(code) {
  if (!weatherSites.delete(code)) return;
  if (currentPatrolCode === code) {
    currentPatrolCode = null;
    updateFocusOutline();
    schedulePatrolNext(0);
  }
  updateWeatherDisplay();
  syncActiveEventLayers();
  renderEventsPanel();
}

// ==================================================
// 気象警報が出ている地域を、1箇所ずつ順番にズームインして巡回する
// - 地震・津波・Jアラート・Lアラート等(activeEvents)が1件でもアクティブな
//   間は、そちらの表示を優先し、巡回によるカメラ移動は行わない
//   (巡回タイマー自体は動き続け、activeEventsが無くなったら自動的に再開する)
// - 一通り巡回し終えたら、PATROL_CYCLE_PAUSE_MS(既定5分)休止してから再開する
// - パネルには気象警報の全カードを常時表示するので、巡回が動かすのは
//   あくまで地図のカメラ位置と輪郭の強調表示だけ
// ==================================================
const PATROL_DWELL_MS = 20000; // 1つの地域を表示し続ける時間
const PATROL_CYCLE_PAUSE_MS = 5 * 60 * 1000; // 一周した後の休止時間
let patrolTimer = null;
let patrolIndex = 0;
let currentPatrolCode = null;

// 気象警報の巡回は、Lアラートの市区町村単位表示ほどの精密さは不要な上、
// 寄りすぎると周辺の地理的な文脈(隣接県との位置関係等)が分からなく
// なるため、通常の上限(maxZoomForBounds)より少し引いた固定値にする
const WEATHER_PATROL_MAX_ZOOM = 7.5;

function zoomToWeatherCode(code) {
  const feature = weatherFeaturesByCode.get(code);
  if (!feature) return;
  // 巡回表示は急いで切り替える必要が無いので瞬時ジャンプにする(軽量化)
  flyToBounds(geometryBounds(feature.geometry), 40, WEATHER_PATROL_MAX_ZOOM, true);
}

function updateFocusOutline() {
  if (!map || !map.getLayer('weather-focus-outline')) return;
  const codes = currentPatrolCode !== null && weatherSites.has(currentPatrolCode) ? [currentPatrolCode] : [];
  map.setFilter('weather-focus-outline', ['in', ['get', 'code'], ['literal', codes]]);
}

function schedulePatrolNext(delayMs) {
  if (patrolTimer) clearTimeout(patrolTimer);
  patrolTimer = setTimeout(patrolStep, delayMs);
}

// テストデータ・訓練放送は本物の警報と違い、巡回ズームを止めてまで
// カメラを占有し続ける理由が無い(実機で、有効期限が長い訓練放送1件が
// 何時間も巡回を止めてしまう不具合が発生した)。「本物の、まだ処理中の
// 警報が無いか」だけをここで判定する
function hasRealActiveEvents() {
  for (const record of activeEvents.values()) {
    if (!record.isTestData && !record.isTraining) return true;
  }
  return false;
}

function patrolStep() {
  // activeEvents(地震・津波・Jアラート・Lアラート等)のうち、テスト
  // データ・訓練放送を除いた「本物」がある間は、そちらの表示を優先する。
  // 新規の気象警報への割り込みズーム(interruptPatrolForNewRegion)で
  // 一時的にカメラを借りていた場合は、ここで重要イベント側へ返す
  if (hasRealActiveEvents()) {
    if (currentPatrolCode !== null) {
      currentPatrolCode = null;
      updateFocusOutline();
      updateCameraForActiveEvents(null);
      renderEventsPanel();
    }
    schedulePatrolNext(PATROL_DWELL_MS);
    return;
  }

  const codes = [...weatherSites.keys()];
  // 気象警報が0件の場合、patrolIndex(0) >= codes.length(0)が常に成り立つ
  // ため、以前ここに専用の早期returnを置いていたが、それは
  // 「currentPatrolCodeが既にnullなら何もしない」という条件付きで
  // カメラを日本全体表示に戻していなかった。テスト/訓練放送だけが
  // activeEventsに残っている状況(currentPatrolCodeはそもそも一度も
  // 立たない)だと、カメラがそこに固定されたまま巡回が永久に始まらない
  // 不具合になっていた(実機で確認)。専用分岐を無くし、下の「一通り
  // 巡回し終えた」分岐(0件なら0周目で即座に真になる)に任せることで、
  // 常に無条件でカメラを戻すようにする
  if (patrolIndex >= codes.length) {
    // 一通り巡回し終えたので、いったん全体表示に戻して休止する
    patrolIndex = 0;
    currentPatrolCode = null;
    const view = getDefaultView();
    map.jumpTo({ center: view.center, zoom: view.zoom }); // 急ぐ必要が無いので瞬時に戻す(軽量化)
    updateFocusOutline();
    renderEventsPanel();
    schedulePatrolNext(PATROL_CYCLE_PAUSE_MS);
    return;
  }

  const code = codes[patrolIndex];
  currentPatrolCode = code;
  zoomToWeatherCode(code);
  updateFocusOutline();
  renderEventsPanel();
  patrolIndex += 1;
  schedulePatrolNext(PATROL_DWELL_MS);
}

// 警報が0件の状態から新しく発表された時は、次の定期チェックを待たず
// すぐに巡回を始める
function kickPatrolIfIdle() {
  if (currentPatrolCode === null && weatherSites.size > 0 && !hasRealActiveEvents()) {
    schedulePatrolNext(0);
  }
}

// 巡回中に別の地域の警報・注意報が新しく発表された場合、次の巡回の
// 順番を待たず、その新しい地域をすぐズームインして見せる。
// 見せ終わったら通常の巡回に戻る(codes配列内での位置を追跡し直し、
// 他の地域を飛ばしたり、同じ地域をすぐ繰り返したりしないようにする)
function interruptPatrolForNewRegion(code) {
  // 津波警報などの重要イベントが表示中でも、新しく発表された気象警報は
  // 一度割り込んでズーム表示する(PATROL_DWELL_MS経過後、patrolStepが
  // 重要イベント側へカメラを返す)。「新しく発表された情報を必ず見せる」
  // という方針をイベント種別によらず一貫させるため
  const codes = [...weatherSites.keys()];
  const idx = codes.indexOf(code);
  if (idx === -1) return;
  currentPatrolCode = code;
  patrolIndex = idx + 1;
  zoomToWeatherCode(code);
  updateFocusOutline();
  renderEventsPanel();
  schedulePatrolNext(PATROL_DWELL_MS);
}

// 震源座標そのものが日本近辺(JAPAN_VICINITY_BOUNDS)から外れているかどうかで
// 海外/遠方の地震を判定する。震源の点だけにズームすると、単なる海上の1点
// しか映らず状況が分かりにくいので、タイトルにも「(海外)」を付けて区別する。
//
// 以前は「eew_forecast_regions_raw/prefectures_rawが無ければ海外」という
// 判定だったが、これらはEEW(緊急地震速報)だけが持つフィールドで、
// 「震源」「震度」種別の通報(disaster_category_no 2, 3)はEEWでない限り
// 国内の地震であっても持たないため、大隅半島東方沖のような普通の国内
// 地震まで「(海外)」と誤表示するバグがあった(実機で確認)。座標そのもの
// で判定するよう修正する
function isForeignOrDistantEarthquake(report) {
  if (![1, 2, 3].includes(report.disaster_category_no)) return false;

  let lon, lat;
  const c = report.coordinates_of_hypocenter;
  if (c && (c.lat_d || c.lat_m || c.lat_s) && (c.lon_d || c.lon_m || c.lon_s)) {
    lat = dmsToDecimal({ d: c.lat_d, m: c.lat_m, s: c.lat_s, negative: c.lat_ns === 1 });
    lon = dmsToDecimal({ d: c.lon_d, m: c.lon_m, s: c.lon_s, negative: c.lon_ew === 1 });
  } else if (typeof report.seismic_epicenter_raw === 'number') {
    const feature = epicenterFeaturesById.get(report.seismic_epicenter_raw);
    const centroid = feature && geometryCentroid(feature.geometry);
    if (centroid) [lon, lat] = centroid;
  }

  if (lon === undefined || lat === undefined) {
    // 座標が全く分からない場合のみ、従来通りEEWの対象地域(都道府県)の
    // 有無をフォールバックの手がかりにする
    const hasDomesticRegions =
      (Array.isArray(report.eew_forecast_regions_raw) && report.eew_forecast_regions_raw.length > 0) ||
      (Array.isArray(report.prefectures_raw) && report.prefectures_raw.length > 0);
    return !hasDomesticRegions;
  }

  const [jMinX, jMinY, jMaxX, jMaxY] = JAPAN_VICINITY_BOUNDS;
  return lon < jMinX || lon > jMaxX || lat < jMinY || lat > jMaxY;
}

// 海外/遠方の地震で日本の対象地域が無い場合に、震源とあわせてズームする
// 「日本本土がだいたい入る」範囲(北海道〜九州、離島は含まない大まかな枠)
const JAPAN_MAINLAND_OVERVIEW_BOUNDS = [129.0, 31.0, 146.0, 45.5];

function buildEventFromReport(report) {
  const geo = { hypocenter: null, tsunami: [], prefectures: [] };
  const boundsList = [];

  // 震源座標が直接わかる場合は最優先でそれを使う(震源に関する情報)
  const c = report.coordinates_of_hypocenter;
  if (c && (c.lat_d || c.lat_m || c.lat_s) && (c.lon_d || c.lon_m || c.lon_s)) {
    const lat = dmsToDecimal({ d: c.lat_d, m: c.lat_m, s: c.lat_s, negative: c.lat_ns === 1 });
    const lon = dmsToDecimal({ d: c.lon_d, m: c.lon_m, s: c.lon_s, negative: c.lon_ew === 1 });
    geo.hypocenter = { lon, lat, label: report.seismic_epicenter };
    boundsList.push([lon, lat, lon, lat]);
  } else if (typeof report.seismic_epicenter_raw === 'number') {
    // 緊急地震速報など、震央地名コードのみわかる場合は震央地名ポリゴンの中心を✕マーカーの位置に使う
    // (赤い塗りつぶし自体は下のeew_forecast_regionsで都道府県単位に行う)
    const feature = epicenterFeaturesById.get(report.seismic_epicenter_raw);
    if (feature) {
      const centroid = geometryCentroid(feature.geometry);
      if (centroid) {
        geo.hypocenter = { lon: centroid[0], lat: centroid[1], label: feature.properties.name };
        // 都道府県の塗りつぶし範囲だけでカメラを合わせると、震源が海上等で
        // その範囲の外にある場合に✕マークが画面外へ見切れてしまうため、
        // 震源座標もカメラ範囲の計算に含める
        boundsList.push([centroid[0], centroid[1], centroid[0], centroid[1]]);
      }
    }
  }

  // 緊急地震速報の対象地域(都道府県単位)を赤で塗りつぶす
  if (Array.isArray(report.eew_forecast_regions_raw) && report.eew_forecast_regions_raw.length) {
    const prefIds = new Set();
    for (const code of report.eew_forecast_regions_raw) {
      for (const id of EEW_REGION_TO_PREFECTURE_IDS[code] || []) prefIds.add(id);
    }
    for (const id of prefIds) {
      geo.prefectures.push({ id, color: '#ff2800', label: null, textColor: '#fff' });
      const feature = prefectureFeaturesById.get(id);
      if (feature) boundsList.push(mainLandBounds(feature.geometry));
    }
  }

  if (Array.isArray(report.tsunami_forecast_regions_raw) && report.tsunami_forecast_regions_raw.length) {
    const color = TSUNAMI_COLORS[report.tsunami_warning_code_raw] || TSUNAMI_DEFAULT_COLOR;
    for (const code of report.tsunami_forecast_regions_raw) {
      geo.tsunami.push({ code, color });
      const feature = tsunamiFeaturesByCode.get(code);
      if (feature) boundsList.push(geometryBounds(feature.geometry));
    }
  }

  if (Array.isArray(report.prefectures_raw) && report.prefectures_raw.length) {
    const intensityCodes = report.seismic_intensities_raw || [];
    report.prefectures_raw.forEach((id, i) => {
      const color = SEISMIC_INTENSITY_COLORS[intensityCodes[i]] || '#999999';
      const label = SEISMIC_INTENSITY_LABELS[intensityCodes[i]] || '?';
      const textColor = SEISMIC_INTENSITY_TEXT_COLORS[intensityCodes[i]] || '#111';
      geo.prefectures.push({ id, color, label, textColor });
      const feature = prefectureFeaturesById.get(id);
      if (feature) boundsList.push(mainLandBounds(feature.geometry));
    });
  }

  const isForeign = isForeignOrDistantEarthquake(report);
  if (isForeign && geo.hypocenter) {
    // 震源(震央マーク)は既にboundsListに入っているので、そこへ日本本土の
    // 概観範囲を合わせてunionし、震源だけでなく日本列島も画面に入るようにする
    boundsList.push(JAPAN_MAINLAND_OVERVIEW_BOUNDS);
  }

  return {
    epicenterRaw: typeof report.seismic_epicenter_raw === 'number' ? report.seismic_epicenter_raw : null,
    disasterCategoryNo: report.disaster_category_no,
    occurrenceTime: report.occurrence_time_of_earthquake || null,
    isTestData: !!report.is_test_data,
    satelliteId: report.satellite_id,
    satellitePrn: report.satellite_prn,
    // 津波警報を目立たせるための専用バナー用の情報
    // (「なし」「解除」は警報中ではないのでバナー/点滅の対象外にする)
    tsunamiWarningText: report.tsunami_warning_code || null,
    tsunamiWarningActive: report.tsunami_warning_code_raw != null && ![1, 2].includes(report.tsunami_warning_code_raw),
    tsunamiWarningColor: TSUNAMI_COLORS[report.tsunami_warning_code_raw] || null,
    badgeText: report.disaster_category || report.type,
    badgeClass: 'report-badge ' + severityClass(report),
    title: buildTitle(report),
    meta: `受信 ${nowTimeString()}`,
    rows: buildSummary(report),
    geo,
    bounds: boundsList.length ? unionBounds(boundsList) : null,
    // 都道府県単位の塗りつぶしは、小さい県だと対象範囲(bbox対角線)が
    // 短く判定され、Lアラートの市区町村向けの上限(11)が誤って適用されて
    // 寄りすぎてしまうことがあるため、県の形が分かる程度の上限に固定する
    boundsMaxZoom: 7.5,
  };
}

// ==================================================
// 複数の通報を同時にアクティブ表示する仕組み
// (取消・警報解除など明示的な信号が来るまで表示し続け、
//  地図は現在アクティブなイベント全部が収まるようにズームアウト/フィットする)
// ==================================================
// 国土地理院ベクトルタイルが存在する下限(zoom4)より下は、
// fallback-landmassレイヤー(prefectures.geojsonによる境界線だけの簡易
// 表示)が肩代わりするため、この程度まで下げても真っ白にはならない。
// 実際にはmaxBounds(日本周辺の範囲)が先に効いて、それ以上は
// ズームアウトできなくなる(自動でクランプされる)
const MAP_MIN_ZOOM = 3.0;

const DEFAULT_VIEW = { center: [135.7671, 35.6812], zoom: 4.55 };
// スマホは最大限ズームアウトした状態を初期値にする
// (実際にはmaxBoundsの都合でMAP_MIN_ZOOMより少し高い値にクランプされる)
const DEFAULT_VIEW_MOBILE = { center: [136.5, 35.5], zoom: MAP_MIN_ZOOM };

// デバイスロックモード(?device=拠点ID、kiosk設置向け)で、拠点に割り
// 当てられた地域が判明したら、アイドル時の既定表示をそこに固定する。
// map.cameraForBounds()はmapインスタンスが必要なため、初回のマップ生成
// (initMap内でgetDefaultView()を呼ぶ最初の1回)には間に合わず、そこだけ
// 一瞬全国表示になる。その後applyDeviceRegionLock()で即座に上書きする。
let lockedDefaultView = null; // {center, zoom} | null

function getDefaultView() {
  if (lockedDefaultView) return lockedDefaultView;
  return isMobileLayout() ? DEFAULT_VIEW_MOBILE : DEFAULT_VIEW;
}

let activeEvents = new Map();
let nextEventId = 1;

// 2つの範囲がおおむね近い(重なる、またはmarginDeg度以内)かどうか。
// 手がかり(震央コード/発生時刻)を持たない通報(津波警報など)を
// 「同じ地震の続報」として統合してよいかの目安に使う。
function boundsAreNear(a, b, marginDeg = 3) {
  return !(
    a[2] + marginDeg < b[0] ||
    b[2] + marginDeg < a[0] ||
    a[3] + marginDeg < b[1] ||
    b[3] + marginDeg < a[1]
  );
}

// 新しく届いた通報(report/eventData)が、既にアクティブな
// どのイベントと「同一の地震」とみなせるかを探す。
// - 震央コード(seismic_epicenter_raw)か地震発生時刻(occurrence_time_of_earthquake)
//   のどちらかが一致すれば同一の地震として扱う(緊急地震速報→震源→震度と続報が来ても
//   カードを増やさず1枚に統合するため)
// - どちらの手がかりも無い通報(津波警報など)は、直近5分以内に更新された、
//   地理的に近いイベントがあればそこに統合する。手がかりもなく近くもなければ
//   別の地震・別の情報として新しいカードにする(離れた地域の別の地震を誤って上書きしないため)
function findMatchingGroup(report, eventData) {
  const epicenterRaw = typeof report.seismic_epicenter_raw === 'number' ? report.seismic_epicenter_raw : null;
  const occurrenceTime = report.occurrence_time_of_earthquake || null;

  if (epicenterRaw != null || occurrenceTime != null) {
    for (const record of activeEvents.values()) {
      if (record.isTransientNotice) continue; // 取消・解除などの短時間通知カードには統合しない
      if (epicenterRaw != null && record.epicenterRaw === epicenterRaw) return record;
      if (occurrenceTime != null && record.occurrenceTime === occurrenceTime) return record;
    }
    return null;
  }

  // Lアラート/Jアラートは「災害種別+対象地域」のキー(lalertKey/jalertKey)で
  // 同一アラートかどうかを判定できる。同じ内容が配信終了条件を満たすまで
  // 数分おきに繰り返し配信される仕様のため、下のRECENT_MS(5分)による
  // 「直近・近い範囲」フォールバックだけに頼ると、再送の間隔が5分を
  // 超えた場合に同じアラートなのに別カードとして重複作成されてしまう
  // (実機で確認: 12時間有効なLアラート訓練放送が数分間隔で再送され、
  // 一部だけ統合されず複数カード化していた)
  if (eventData.lalertKey || eventData.jalertKey) {
    for (const record of activeEvents.values()) {
      if (record.isTransientNotice) continue;
      if (eventData.lalertKey && record.lalertKey === eventData.lalertKey) return record;
      if (eventData.jalertKey && record.jalertKey === eventData.jalertKey) return record;
    }
    return null;
  }

  const RECENT_MS = 5 * 60 * 1000;
  const now = Date.now();
  let best = null;
  for (const record of activeEvents.values()) {
    // 取消・解除・デコードエラーなどの短時間通知カード(isTransientNotice)は
    // 「地震グループ」ではないため統合先にしない。以前これが原因で、
    // EEW取消の直後に届いた津波警報が「取消」通知カードへ統合されて
    // しまい、通知カードの自動消滅タイマー(10秒)と一緒に津波警報の
    // 表示ごと消えるという重大なバグがあった。
    // (以前はこの判定にttlMsの有無を使っていたが、通常の地震・津波
    // イベントにも安全策としてttlMsを持たせるようになったため、
    // 「短時間通知カードかどうか」を表す専用フラグに切り出した)
    if (record.isTransientNotice) continue;
    if (now - record.updatedAt > RECENT_MS) continue;
    if (eventData.bounds && record.bounds && !boundsAreNear(eventData.bounds, record.bounds)) continue;
    if (!best || record.updatedAt > best.updatedAt) best = record;
  }
  return best;
}

function createHypocenterMarkers(hypocenter) {
  // 震央の地名はパネルの「震央」欄に表示しているため、地図上の✕マークに
  // 地名ラベルは付けない(沖合の震源で海上に地名が浮かぶのは煩わしいため)
  const markers = { hypocenter: null, hypocenterLabel: null };
  const { lon, lat } = hypocenter;
  markers.hypocenter = new maplibregl.Marker({ element: createCrossMarkerElement(), anchor: 'center' })
    .setLngLat([lon, lat])
    .addTo(map);
  return markers;
}

function createIntensityBadgeMarkers(prefectures) {
  const markers = [];
  const scale = intensityBadgeScaleForZoom(map.getZoom());
  for (const p of prefectures) {
    if (!p.label) continue; // Jアラート(震度のような段階なし)はバッジを付けない
    const feature = prefectureFeaturesById.get(p.id);
    if (!feature) continue;
    const centroid = geometryCentroid(feature.geometry);
    if (!centroid) continue;
    const marker = new maplibregl.Marker({ element: createIntensityBadgeElement(p.label, p.color, p.textColor), anchor: 'center' })
      .setLngLat(centroid)
      .addTo(map);
    applyIntensityBadgeScale(marker, scale);
    markers.push(marker);
  }
  return markers;
}

// 警報対象地域の塗りつぶしを先に見せてから、少し遅れてカメラをズーム
// させるまでの間隔(ミリ秒)。0にすると従来通り同時になる
const CAMERA_ZOOM_DELAY_MS = 400;

// ttlMs を指定しない場合は自動消滅させない(取消・警報解除など明示的な
// 信号が来るまで表示し続ける)。「取消」「警報解除」等の短時間だけ
// 出す通知カードにのみ ttlMs を明示的に渡す。
function addActiveEvent(eventData, ttlMs = null) {
  const id = nextEventId++;
  const record = {
    id,
    ...eventData,
    badges: [{ text: eventData.badgeText, class: eventData.badgeClass }],
    epicenterRaw: eventData.epicenterRaw ?? null,
    occurrenceTime: eventData.occurrenceTime ?? null,
    updatedAt: Date.now(),
    ttlMs,
    markers: { hypocenter: null, hypocenterLabel: null, intensityBadges: [] },
  };

  record.timer = ttlMs ? setTimeout(() => removeActiveEvent(id), ttlMs) : null;
  activeEvents.set(id, record);
  // 地震・津波・Jアラート・Lアラート等が発生した場合、地図はそちらに
  // ズームするため、それまで気象警報の巡回で表示していた地域の
  // カード/輪郭強調は(カメラが実際にはもうそこを見ていないので)消す
  if (currentPatrolCode !== null) {
    currentPatrolCode = null;
    updateFocusOutline();
  }
  // 表示の優先順位: 1.警報対象地域の塗りつぶし(最優先、一目で範囲が
  // 分かる) 2.震源(✕)・震度バッジのマーカー 3.カメラズーム(最後、
  // 遅延させて色を見せてから動かす)。マーカー生成(DOM要素の作成・
  // マップへの追加)は塗りより後にすることで、色が先に画面へ反映される
  syncActiveEventLayers();
  if (record.geo.hypocenter) Object.assign(record.markers, createHypocenterMarkers(record.geo.hypocenter));
  record.markers.intensityBadges = createIntensityBadgeMarkers(record.geo.prefectures);
  // 塗りつぶしの反映とカメラのズーム移動を同じフレームで同時に行うと、
  // 色が付いた瞬間が見えないまま(既にズームが始まった状態で)表示されて
  // しまうため、一度そのままの画面で色を見せてから少し遅れてズームする
  // updateCameraForActiveEventsはfocusedEventIds(パネルにどれを表示
  // するか)もここで決めるため、ズームを遅延させた分パネル表示も
  // 遅延後のコールバック内で改めて更新する(遅延前に呼ぶと
  // focusedEventIdsがまだ更新されておらず、パネルが空のまま表示
  // されてしまう)
  requestAnimationFrame(() => setTimeout(() => {
    // テストデータ・訓練放送はカメラを占有しない(巡回ズームを妨げない
    // ようにするため)。塗り・マーカー・パネルカードは通常通り表示する
    if (!record.isTestData && !record.isTraining) updateCameraForActiveEvents(record);
    renderEventsPanel();
  }, CAMERA_ZOOM_DELAY_MS));
}

// 既にアクティブな同一地震のイベントに、新しい通報の内容を統合する
// (震源位置の更新で✕マーカーが重複しないよう差し替え、都道府県の
//  塗りつぶし・詳細項目は最新の内容で上書きしつつ足りないものは追加する)
// newTtlMs: 今回の通報自体が本来持つべき安全策TTL。例えば震度速報
// (15分)のカードに津波警報(24時間)が統合された場合、より長い方を
// 採用する(短い方に引きずられて津波警報ごと早期に消えないようにする)
function mergeIntoActiveEvent(record, eventData, report, newTtlMs = null) {
  clearTimeout(record.timer);
  if (newTtlMs != null) record.ttlMs = Math.max(record.ttlMs || 0, newTtlMs);

  // 表示の優先順位: 1.警報対象地域の塗りつぶし 2.震源・震度バッジの
  // マーカー 3.カメラズーム。まずマーカーに関わるデータだけ更新し
  // (DOM操作はまだしない)、塗りつぶし(syncActiveEventLayers)を
  // 先に反映してから、その後でマーカーのDOM要素を作り直す
  const hypocenterChanged = !!eventData.geo.hypocenter;
  if (hypocenterChanged) record.geo.hypocenter = eventData.geo.hypocenter;

  // 都道府県の塗りつぶしは「統合」ではなく「置き換え」にする。
  // 例えば緊急地震速報(予報区ベースの広い赤塗り)のあとに震度速報
  // (実際に観測された震度)が来た場合、震度速報の対象外の県にまで
  // 赤塗りが残り続けるのを防ぐため、新しい情報を持つ通報が来たら
  // 都道府県リストはその内容で丸ごと置き換える(情報を持たない
  // 通報、例えば震源に関する情報は何もしない=前の表示を維持する)
  const prefecturesChanged = !!eventData.geo.prefectures.length;
  if (prefecturesChanged) record.geo.prefectures = eventData.geo.prefectures;

  if (eventData.geo.tsunami.length) {
    record.geo.tsunami = eventData.geo.tsunami;
  }

  if (eventData.tsunamiWarningText) {
    record.tsunamiWarningText = eventData.tsunamiWarningText;
    record.tsunamiWarningActive = eventData.tsunamiWarningActive;
    record.tsunamiWarningColor = eventData.tsunamiWarningColor;
  }

  record.bounds = record.bounds && eventData.bounds
    ? unionBounds([record.bounds, eventData.bounds])
    : (eventData.bounds || record.bounds);

  // 通報の種類ごとのバッジ(緊急地震速報/震源/震度/津波)を統合する。
  // 同じ種類の続報が来た場合は内容を更新し、新しい種類なら追加する
  const badgeIdx = record.badges.findIndex((b) => b.text === eventData.badgeText);
  if (badgeIdx >= 0) record.badges[badgeIdx] = { text: eventData.badgeText, class: eventData.badgeClass };
  else record.badges.push({ text: eventData.badgeText, class: eventData.badgeClass });

  // 詳細項目(rows)を統合。同じ項目名は最新の値で上書きし、新しい項目は追加する
  const rowsMap = new Map(record.rows);
  for (const [k, v] of eventData.rows) rowsMap.set(k, v);
  record.rows = [...rowsMap.entries()];

  record.title = eventData.title;
  record.meta = eventData.meta;
  record.satelliteId = eventData.satelliteId;
  record.satellitePrn = eventData.satellitePrn;
  record.isTestData = record.isTestData || eventData.isTestData;
  record.isTraining = record.isTraining || eventData.isTraining;
  if (typeof report.seismic_epicenter_raw === 'number') record.epicenterRaw = report.seismic_epicenter_raw;
  if (report.occurrence_time_of_earthquake) record.occurrenceTime = report.occurrence_time_of_earthquake;
  record.updatedAt = Date.now();

  record.timer = record.ttlMs ? setTimeout(() => removeActiveEvent(record.id), record.ttlMs) : null;
  syncActiveEventLayers();
  // 塗りつぶしを反映した後で、変化があった分だけマーカーのDOM要素を
  // 作り直す(優先順位2番目)
  if (hypocenterChanged) {
    if (record.markers.hypocenter) record.markers.hypocenter.remove();
    if (record.markers.hypocenterLabel) record.markers.hypocenterLabel.remove();
    Object.assign(record.markers, createHypocenterMarkers(record.geo.hypocenter));
  }
  if (prefecturesChanged) {
    for (const marker of record.markers.intensityBadges) marker.remove();
    record.markers.intensityBadges = createIntensityBadgeMarkers(record.geo.prefectures);
  }
  // 更新された(続報が来た)イベントも「新しく発表された方」として扱い、
  // そちらを優先してズームする(気象警報の巡回フォーカスは解除する)
  if (currentPatrolCode !== null) {
    currentPatrolCode = null;
    updateFocusOutline();
  }
  // updateCameraForActiveEventsはfocusedEventIds(パネルにどれを表示
  // するか)もここで決めるため、ズームを遅延させた分パネル表示も
  // 遅延後のコールバック内で改めて更新する(遅延前に呼ぶと
  // focusedEventIdsがまだ更新されておらず、パネルが空のまま表示
  // されてしまう)
  requestAnimationFrame(() => setTimeout(() => {
    // テストデータ・訓練放送はカメラを占有しない(巡回ズームを妨げない
    // ようにするため)。塗り・マーカー・パネルカードは通常通り更新する
    if (!record.isTestData && !record.isTraining) updateCameraForActiveEvents(record);
    renderEventsPanel();
  }, CAMERA_ZOOM_DELAY_MS));
}

function removeActiveEvent(id) {
  const record = activeEvents.get(id);
  if (!record) return;
  if (record.markers.hypocenter) record.markers.hypocenter.remove();
  if (record.markers.hypocenterLabel) record.markers.hypocenterLabel.remove();
  for (const marker of record.markers.intensityBadges) marker.remove();
  activeEvents.delete(id);
  syncActiveEventLayers();
  // 何を優先すべきか特に無い(消えた側なので)。残っている中で直近の
  // ものを見せるか、何も残っていなければ通常の待機表示に戻す。
  // ただし気象警報の巡回/割り込み(currentPatrolCode)がカメラを持って
  // いる間は横取りしない(巡回が終われば patrolStep が復帰させる)
  if (currentPatrolCode === null) {
    updateCameraForActiveEvents(null);
  }
  renderEventsPanel();
}

// WebSocket接続(再接続含む)のたびに呼ぶ。サーバーは接続直後に
// 「現在アクティブな」通報一覧を送り直してくれるが、それだけでは
// 取消(キャンセル)によってサーバー側では既に消えている通報が、
// クライアント側にはそのまま残り続けてしまう(取消メッセージ自体は
// 再送されないため)。再接続のたびにローカル状態を一旦空にし、
// サーバーから届く内容だけで組み直すことで、複数端末間の表示が
// 常に一致するようにする。
function clearAllActiveEvents() {
  for (const id of [...activeEvents.keys()]) removeActiveEvent(id);
  weatherSites.clear();
  otherReports.clear();
  currentPatrolCode = null;
  patrolIndex = 0;
  updateWeatherDisplay();
  updateFocusOutline();
  renderEventsPanel();
}

// 津波警報が出ている間、沿岸ラインを点滅させて目立たせる
// (パネルのバナー自体は点滅させない、常時表示のみ)
let tsunamiBlinkTimer = null;

function applyTsunamiBlinkVisual(visible) {
  if (map && map.getLayer('tsunami-line')) {
    map.setPaintProperty('tsunami-line', 'line-opacity', visible ? 1 : 0.25);
  }
}

function startTsunamiBlink() {
  if (tsunamiBlinkTimer) return; // 既に点滅中
  let visible = true;
  applyTsunamiBlinkVisual(true);
  tsunamiBlinkTimer = setInterval(() => {
    visible = !visible;
    applyTsunamiBlinkVisual(visible);
  }, 450);
}
function stopTsunamiBlink() {
  if (!tsunamiBlinkTimer) return;
  clearInterval(tsunamiBlinkTimer);
  tsunamiBlinkTimer = null;
  applyTsunamiBlinkVisual(true);
}

// アクティブな全イベントを合算して、レイヤーのフィルタ/色と
// ズーム範囲(併記表示のためのズームアウト)を再計算する
// レイヤーの塗り/フィルタだけを更新する(カメラは動かさない)。
// 「同時に複数箇所が発表されていても、新しく発表された方を優先して
// ズーム表示する」ため、カメラ移動は呼び出し側(addActiveEvent等)が
// updateCameraForActiveEvents で個別に指示する形にしている。
function syncActiveEventLayers() {
  if (!map || !map.getLayer('prefecture-fill')) return;

  const tsunamiColorByCode = new Map();
  const prefColorById = new Map();
  const municipalityColorByCode = new Map();
  const ellipseFeatures = [];
  let tsunamiActive = false;

  for (const record of activeEvents.values()) {
    for (const t of record.geo.tsunami) tsunamiColorByCode.set(t.code, t.color);
    for (const p of record.geo.prefectures) prefColorById.set(p.id, p.color);
    if (record.geo.municipality) municipalityColorByCode.set(record.geo.municipality.code, record.geo.municipality.color);
    if (record.geo.ellipse) {
      ellipseFeatures.push({
        type: 'Feature',
        properties: { color: record.geo.ellipse.color },
        geometry: record.geo.ellipse.polygon,
      });
    }
    if (record.tsunamiWarningActive) tsunamiActive = true;
  }

  if (map.getSource('lalert-ellipses')) {
    map.getSource('lalert-ellipses').setData({ type: 'FeatureCollection', features: ellipseFeatures });
  }

  if (tsunamiColorByCode.size) {
    const matchExpr = ['match', ['get', 'code']];
    for (const [code, color] of tsunamiColorByCode) matchExpr.push(code, color);
    matchExpr.push(TSUNAMI_DEFAULT_COLOR);
    map.setFilter('tsunami-line', ['in', ['get', 'code'], ['literal', [...tsunamiColorByCode.keys()]]]);
    map.setPaintProperty('tsunami-line', 'line-color', matchExpr);
    if (tsunamiActive) startTsunamiBlink(); else stopTsunamiBlink();
  } else {
    map.setFilter('tsunami-line', ['in', ['get', 'code'], ['literal', []]]);
    stopTsunamiBlink();
  }

  if (prefColorById.size) {
    const matchExpr = ['match', ['get', 'id']];
    for (const [id, color] of prefColorById) matchExpr.push(id, color);
    matchExpr.push('rgba(0,0,0,0)');
    map.setFilter('prefecture-fill', ['in', ['get', 'id'], ['literal', [...prefColorById.keys()]]]);
    map.setFilter('prefecture-outline', ['in', ['get', 'id'], ['literal', [...prefColorById.keys()]]]);
    map.setPaintProperty('prefecture-fill', 'fill-color', matchExpr);
  } else {
    map.setFilter('prefecture-fill', ['in', ['get', 'id'], ['literal', []]]);
    map.setFilter('prefecture-outline', ['in', ['get', 'id'], ['literal', []]]);
  }

  // 市区町村ポリゴン(約1900件、一番重いレイヤー)はkiosk表示の初期
  // 描画を軽くするため起動時に読み込まず、Lアラート(市区町村指定)が
  // 実際に届いた時にバックグラウンドで読み込む(ensureMunicipalityLayer)。
  // まだ読み込まれていない間は何もしない(読み込み完了後に改めて
  // syncActiveEventLayersが呼ばれる)
  if (map.getLayer('municipality-fill')) {
    // ソースには今アクティブな市区町村の分だけを入れる(全国約1900件を
    // 常時保持しない。詳細はensureMunicipalityLayer参照)
    const activeFeatures = [...municipalityColorByCode.keys()]
      .map((code) => municipalityFeaturesByCode.get(code))
      .filter(Boolean);
    map.getSource('municipality-regions').setData({ type: 'FeatureCollection', features: activeFeatures });
    if (municipalityColorByCode.size) {
      const matchExpr = ['match', ['get', 'code']];
      for (const [code, color] of municipalityColorByCode) matchExpr.push(code, color);
      matchExpr.push('rgba(0,0,0,0)');
      map.setPaintProperty('municipality-fill', 'fill-color', matchExpr);
    }
  }

}

// カメラ位置を決める。preferredRecord を渡すと「今まさに新規追加/更新された
// イベント」を最優先でズーム表示する(複数箇所が同時にアクティブでも、
// 新しく発表された方が見える、という挙動のため)。ただし津波警報が
// 出ている間は、何が新しく届いたかによらず津波の対象沿岸を最優先で見せる
// (人命に関わる優先度が最も高いため)。
// パネルは「地図が今まさにズームして見せている対象」だけを表示する
// (無関係な場所の情報が並んで混乱するのを防ぐため)。activeEventsの
// うち、実際にカメラがズームインしている記録のidをここに追跡し、
// renderEventsPanelがこれを見て表示するカードを絞り込む
let focusedEventIds = new Set();

// 都道府県全体ではなく、実際に警報が出ている沿岸そのものを見せた方が
// 分かりやすいが、寄りすぎると逆にどこの県か分からなくなるため、
// 通常のprefecture単位より少し狭いが県の形は分かる程度の上限にする
const TSUNAMI_FOCUS_MAX_ZOOM = 7.5;

function updateCameraForActiveEvents(preferredRecord) {
  if (!map) return;

  // 明示的な優先イベントが指定されていない場合(再接続時の一括再送や、
  // 市区町村データの遅延読み込み完了時など)は、直近に更新されたイベントを
  // 優先候補として補う。これが無いと「誰が新しいか分からないので全部
  // union fitする」しかできず、例えば札幌と那覇のLアラートが両方
  // 保留から同時に解決した時に、日本全体を映す中途半端なズームになって
  // しまう(実際に発生を確認して修正した)。
  //
  // 以前は「津波警報が1件でもあれば無条件で最優先」という扱いだったが、
  // それだと津波警報が出っぱなしの間、後から発表された無関係の警報や
  // Lアラートがいつまでもズームされない不具合になっていた。津波警報も
  // 他のイベントと同じく「一番新しいものを優先」の対象にし、それが
  // たまたま津波警報だった場合だけ、沿岸に寄った見せ方をする
  if (!preferredRecord) {
    // テストデータ・訓練放送はカメラを占有しない方針(addActiveEvent/
    // mergeIntoActiveEventの呼び出し元では既に除外しているが、
    // removeActiveEvent等からpreferredRecord無しで呼ばれた時のこの
    // フォールバック選択でも同様に除外しないと、訓練放送だけが
    // activeEventsに残っている状況で「一番新しいもの」として選ばれて
    // しまい、巡回ズームがそちらに奪われ続ける不具合になる(実機で確認)
    let latest = null;
    for (const record of activeEvents.values()) {
      if (record.isTestData || record.isTraining) continue;
      if (record.bounds && (!latest || record.updatedAt > latest.updatedAt)) latest = record;
    }
    preferredRecord = latest;
  }

  if (preferredRecord && preferredRecord.tsunamiWarningActive) {
    const tsunamiBoundsList = [];
    for (const t of preferredRecord.geo.tsunami) {
      const feature = tsunamiFeaturesByCode.get(t.code);
      if (feature) tsunamiBoundsList.push(geometryBounds(feature.geometry));
    }
    if (tsunamiBoundsList.length) {
      flyToBounds(unionBounds(tsunamiBoundsList), 24, TSUNAMI_FOCUS_MAX_ZOOM);
      focusedEventIds = new Set([preferredRecord.id]);
      return;
    }
  }

  if (preferredRecord && preferredRecord.bounds) {
    flyToBounds(preferredRecord.bounds, 24, preferredRecord.boundsMaxZoom ?? null);
    focusedEventIds = new Set([preferredRecord.id]);
    return;
  }

  // 位置情報を持たないイベント(取消・解除の短時間通知カード、
  // デコードエラー、対象地域を特定できないJアラート等)。カメラは
  // 残っている他のイベント(あれば直近のもの)に合わせつつ、パネルには
  // この通知も表示する(bounds有無でフォーカスを決めると、これらの
  // 通知カードが一切表示されない不具合になる)
  if (preferredRecord) {
    let latest = null;
    for (const record of activeEvents.values()) {
      if (record.bounds && (!latest || record.updatedAt > latest.updatedAt)) latest = record;
    }
    if (latest) {
      flyToBounds(latest.bounds, 24, latest.boundsMaxZoom ?? null);
      focusedEventIds = new Set([preferredRecord.id, latest.id]);
    } else {
      focusedEventIds = new Set([preferredRecord.id]);
      if (currentPatrolCode === null) {
        const view = getDefaultView();
        map.jumpTo({ center: view.center, zoom: view.zoom }); // 急ぐ必要が無いので瞬時に戻す(軽量化)
      }
    }
    return;
  }

  // 気象警報(weatherSites)はここには含めない。気象警報のカメラ制御は
  // 巡回(patrolStep/interruptPatrolForNewRegion)が専任で行うため、
  // ここで一緒にunion fitしてしまうと、巡回とカメラを取り合ってしまう。
  // (ここに到達するのは、活動中のイベントが1件もboundsを持たない
  // 稀なケースのみ)
  const boundsList = [];
  const idsWithBounds = [];
  for (const record of activeEvents.values()) {
    if (record.bounds) {
      boundsList.push(record.bounds);
      idsWithBounds.push(record.id);
    }
  }
  if (boundsList.length) {
    // オートズーム: アクティブな全イベントが収まるようにズームアウト/フィット
    // (パディングを詰めて、対象地域によりズームインする)
    flyToBounds(unionBounds(boundsList), 24);
    focusedEventIds = new Set(idsWithBounds);
  } else if (currentPatrolCode === null) {
    // 何もアクティブでなく、気象警報の巡回もしていなければ日本全体表示に戻す。
    // 巡回中(currentPatrolCode有り)は、そちらがカメラを管理しているので
    // ここでは何もしない(勝手にリセットして巡回とカメラの取り合いに
    // ならないようにする)
    const view = getDefaultView();
    map.jumpTo({ center: view.center, zoom: view.zoom }); // 急ぐ必要が無いので瞬時に戻す(軽量化)
    focusedEventIds = new Set();
  } else {
    focusedEventIds = new Set();
  }
}

// 気象警報(weatherSites)・その他(otherReports)は
// activeEventsとは別のMapで管理している。気象警報は同時に何十件も
// アクティブになりうるため、他の通報と違って「常時全件表示」にはせず、
// 地図が実際にズームインして見せている(=巡回中の)地域のカードだけを
// パネルにも表示する(地図はどこか別の場所を見ているのに、パネルには
// 無関係な地域の情報が並んでいる、という食い違いを防ぐため)
function weatherSiteCard(site) {
  const worst = worstSubCategory(site.subCategories);
  return {
    isTestData: site.isTestData,
    satelliteId: site.satelliteId,
    satellitePrn: site.satellitePrn,
    badges: [{ text: worst || '気象', class: weatherSeverityBadgeClass(worst) }],
    title: `📍 ${site.name}`,
    meta: `更新 ${nowTimeString()}`,
    rows: [['種別', site.subCategories.join('・')]],
    updatedAt: site.updatedAt,
  };
}

function otherReportCard(rec) {
  return {
    isTestData: rec.isTestData,
    satelliteId: rec.satelliteId,
    satellitePrn: rec.satellitePrn,
    badges: [{ text: rec.badgeText, class: rec.badgeClass }],
    title: rec.title,
    meta: rec.meta,
    rows: rec.rows,
    updatedAt: rec.updatedAt,
  };
}

function renderEventsPanel() {
  const container = document.getElementById('events_container');
  if (!container) return;

  // パネルには「地図が今まさにズームして見せている対象」だけを出す。
  // currentPatrolCodeが立っている間は巡回(または新規気象警報への
  // 割り込み)がカメラを持っているのでその地域だけ、そうでなければ
  // ズームフォーカス中のactiveEvents(地震・津波・Jアラート・Lアラート等)、
  // どちらでも無い(=全体表示に戻っている)時だけ、その他の通報
  // (南海トラフ/火山/降灰/洪水。特定の位置にズームする仕組みが無い)を出す
  const focusedEvents = [...activeEvents.values()].filter((r) => focusedEventIds.has(r.id));
  const focusedWeatherSite = currentPatrolCode !== null ? weatherSites.get(currentPatrolCode) : null;

  let visibleRecords;
  if (focusedWeatherSite) {
    visibleRecords = [weatherSiteCard(focusedWeatherSite)];
  } else if (focusedEvents.length) {
    visibleRecords = focusedEvents;
  } else {
    visibleRecords = [...otherReports.values()].map(otherReportCard);
  }

  if (!visibleRecords.length) {
    // 何もアクティブでなく、気象警報の巡回でズームしている地域も無い場合は
    // パネルは何も表示しない(地図上の描画だけを見せる)。時刻・オンライン
    // 状態などのヘッダー部分は別途常時表示されているので、ここが空でも
    // 「アプリが止まっている」ようには見えない
    container.innerHTML = '';
    return;
  }

  const cardsHtml = visibleRecords
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) // 新しい順
    .map((record) => {
      const testBanner = record.isTestData ? '<div class="test-data-banner">🧪 テストデータ</div>' : '';
      const tsunamiBanner = record.tsunamiWarningActive
        ? `<div class="tsunami-alert-banner" style="background:${escapeHtml(record.tsunamiWarningColor || TSUNAMI_DEFAULT_COLOR)}">${escapeHtml(record.tsunamiWarningText)}</div>`
        : '';
      const satelliteTag = (record.satellitePrn !== undefined && record.satellitePrn !== null)
        ? `<span class="satellite-tag">🛰️ ${escapeHtml(SATELLITE_NAMES[record.satelliteId] || `PRN${record.satellitePrn}`)}</span>`
        : '';
      const badgesHtml = (record.badges || [{ text: record.badgeText, class: record.badgeClass }])
        .map((b) => `<div class="${escapeHtml(b.class)}">${escapeHtml(b.text)}</div>`)
        .join('');
      const rowsHtml = record.rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('');
      const cardClass = cardSeverityClass(record.badges || [{ class: record.badgeClass }]);
      return `
        <div class="report-card ${escapeHtml(cardClass)}">
          ${testBanner}
          ${tsunamiBanner}
          <div class="report-badge-row">
            <div class="badges-list">${badgesHtml}</div>
            ${satelliteTag}
          </div>
          <div class="report-title">${escapeHtml(record.title)}</div>
          <div class="report-meta">${escapeHtml(record.meta)}</div>
          <dl class="report-summary">${rowsHtml}</dl>
        </div>`;
    })
    .join('');
  container.innerHTML = cardsHtml;
}

// ==================================================
// 受信した災危通報(JSON)を画面と地図に反映する
// ==================================================
// 取消・解除信号が来れば従来通りそれを最優先で使う(このセクションの
// 各TTLは「取消・解除が何らかの理由で届かなかった場合」の安全策)。
// 緊急地震速報は本質的に速報性の高い情報のため短め、震源・震度速報は
// 事実情報でそもそも取消の仕組みが無いため「最後の更新から」の猶予、
// 津波・警報系は安全側に倒して長めに設定している。
const TTL_EEW_MS = 10 * 60 * 1000; // 緊急地震速報: 10分
const TTL_HYPOCENTER_INTENSITY_MS = 15 * 60 * 1000; // 震源・震度速報: 最後の更新から15分
const TTL_TSUNAMI_MS = 24 * 60 * 60 * 1000; // 津波: 24時間
const TTL_JALERT_MS = 24 * 60 * 60 * 1000; // Jアラート: 24時間
const TTL_WEATHER_MS = 24 * 60 * 60 * 1000; // 気象警報・注意報: 最後の更新から24時間
const TTL_OTHER_CATEGORY_MS = 24 * 60 * 60 * 1000; // 南海トラフ/火山/降灰/洪水: 最後の更新から24時間

// Lアラートはa8_hazard_duration(CAP標準の継続時間、azarashi定義で
// 4値のみ)を持っていればそれを上限として使う。HAZARD_DURATION_JA
// (623行目付近)と同じキーで揃えてある
const LALERT_DURATION_TTL_MS = {
  'Duration < 6H': 6 * 60 * 60 * 1000,
  '6H <= Duration < 12H': 12 * 60 * 60 * 1000,
  '12H <= Duration < 24H': 24 * 60 * 60 * 1000,
};
function lalertTtlMs(report) {
  return LALERT_DURATION_TTL_MS[report.a8_hazard_duration] || TTL_JALERT_MS; // Unknown/未設定なら24時間
}

// テストデータ(is_test_data)は動作確認用の一時的な表示なので、
// 本物の警報と同じ長いTTLを待たず、短時間(1分)で自動的に消す
const TTL_TEST_DATA_MS = 60 * 1000;

function ttlMsForReport(report) {
  if (report.is_test_data) return TTL_TEST_DATA_MS;
  if (report.disaster_category_no === 2 || report.disaster_category_no === 3) return TTL_HYPOCENTER_INTENSITY_MS;
  if (report.disaster_category_no === 5) return TTL_TSUNAMI_MS;
  return null;
}

// キャンセル報(取消): 気象庁が既に発表した通報を取り下げるもの。
// 同じ震央のアクティブな表示を即座に取り下げ、代わりに短時間だけ「取消」を通知する
// (表示地域の絞り込みで元の通報自体が表示されていなかった場合は、
//  取り下げるものが無いので「取消」の通知も出さない=絞り込みが全ての
//  情報種別に一貫して効くようにする)
function handleCancellation(report) {
  let removedAny = false;
  for (const [id, record] of activeEvents) {
    if (record.epicenterRaw != null && record.epicenterRaw === report.seismic_epicenter_raw) {
      removeActiveEvent(id);
      removedAny = true;
    }
  }
  if (!removedAny) return;

  addActiveEvent(
    {
      isTestData: !!report.is_test_data,
      satelliteId: report.satellite_id,
      satellitePrn: report.satellite_prn,
      badgeText: '取消',
      badgeClass: 'report-badge sev-cancel',
      title: `${report.disaster_category || report.type}(取消)`,
      meta: `受信 ${nowTimeString()}`,
      rows: [['対象', report.seismic_epicenter || '']].filter(([, v]) => v),
      geo: { hypocenter: null, tsunami: [], prefectures: [] },
      bounds: null,
      isTransientNotice: true, // findMatchingGroupの統合対象から除外する
    },
    10000 // 取消の通知は短めに表示する
  );
}

// 津波警報の解除・「津波なし」(tsunami_warning_code_raw が 1 or 2)を受信した場合、
// 危険な状況が収束したとみなして画面をリセットする(津波を含んでいた
// アクティブなイベントを消し、短時間だけ「解除」の通知を出す)
// こちらも表示地域の絞り込みで元の津波警報自体が表示されていなかった
// 場合は、解除の通知も出さない
function handleTsunamiResolution(report) {
  let removedAny = false;
  for (const [id, record] of activeEvents) {
    if (record.geo.tsunami.length) {
      removeActiveEvent(id);
      removedAny = true;
    }
  }
  if (!removedAny) return;

  addActiveEvent(
    {
      isTestData: !!report.is_test_data,
      satelliteId: report.satellite_id,
      satellitePrn: report.satellite_prn,
      badgeText: report.tsunami_warning_code || '津波警報解除',
      badgeClass: 'report-badge sev-resolved',
      title: report.tsunami_warning_code || '津波警報解除',
      meta: `受信 ${nowTimeString()}`,
      rows: [],
      geo: { hypocenter: null, tsunami: [], prefectures: [] },
      bounds: null,
      isTransientNotice: true,
    },
    10000
  );
}

// ==================================================
// デバイスロックモード(?device=拠点ID)
//
// サイネージ/kiosk設置向け。URLに ?device=<拠点ID> が付いている場合のみ、
// 管理サイト(device-admin)でその拠点に割り当てられた都道府県+周辺地方
// (/device-region/:deviceId、サーバー側で展開済み)に表示を固定する。
// パラメータが無い通常の閲覧(一般公開ビュー)は今まで通り絞り込みなし・
// 全国巡回のまま。
// ==================================================
const LOCKED_DEVICE_ID = new URLSearchParams(location.search).get('device');
let lockedPrefectureIds = null; // Set<number> | null(拠点に地域が割り当てられている場合のみ)

async function applyDeviceRegionLock() {
  if (!LOCKED_DEVICE_ID) return;
  try {
    const res = await fetch(`/device-region/${encodeURIComponent(LOCKED_DEVICE_ID)}`);
    const data = await res.json();
    if (!Array.isArray(data.prefectureIds) || !data.prefectureIds.length) return; // 未割り当て=絞り込みなしのまま
    lockedPrefectureIds = new Set(data.prefectureIds);
    const boundsList = [...lockedPrefectureIds]
      .map((id) => prefectureFeaturesById.get(id))
      .filter(Boolean)
      .map((f) => mainLandBounds(f.geometry));
    if (!boundsList.length) return;
    const [minX, minY, maxX, maxY] = unionBounds(boundsList);
    lockedDefaultView = map.cameraForBounds([[minX, minY], [maxX, maxY]], { padding: 40 });
    map.jumpTo(lockedDefaultView);
  } catch (err) {
    console.warn('拠点の地域設定の取得に失敗しました(絞り込みなしで続行):', err);
  }
}

// 未割り当て(null)なら絞り込みなし。対象都道府県が判別できない通報
// (震源のみの情報・津波情報など geo.prefectures が空のもの)は
// 絞り込み対象外として常に表示する。
function getTargetPrefectureIds() {
  return lockedPrefectureIds;
}

function isRelevantToTargetRegion(eventData) {
  const targetIds = getTargetPrefectureIds();
  if (!targetIds) return true; // 絞り込み未設定
  if (!eventData.geo.prefectures.length) return true; // 対象都道府県が不明な通報は常に表示
  return eventData.geo.prefectures.some((p) => targetIds.has(p.id));
}

// 訓練/試験放送(DCRはreport_classification_no===7、Jアラート/Lアラートは
// a1_message_type==='Test')の見出しに「[訓練]」を付与する。色
// (sev-training)はseverityClass/otherBadgeClassForReport/
// jalertSeverityClassが既に対応済みなので、ここではテキストのみ扱う。
// event.title(activeEvents・otherReports)/event.name(weatherSites)の
// どちらか存在する方に付ける。
// isTrainingフラグは巡回ズームがブロックされないようにするために使う
// (訓練放送1件が本番の警報と同列にカメラを占有し続け、何時間も巡回が
// 始まらなくなる不具合が実機で発生したため)
function applyTrainingLabel(event, report) {
  const isTraining = report.report_classification_no === 7 || report.a1_message_type === 'Test';
  if (isTraining) event.isTraining = true;
  if (report.report_classification_no !== 7) return event;
  if (event.title) event.title = `[訓練] ${event.title}`;
  if (event.name) event.name = `[訓練] ${event.name}`;
  return event;
}

function renderReport(report) {
  // report_classification_no===7は衛星から実際に配信される公式の訓練/試験放送
  // (月2回程度)。showTrainingBroadcasts=trueなら本物と全く同じ経路で
  // 表示する(バッジ・タイトルへの「[訓練]」付与はapplyTrainingLabel、
  // severityClassが色をsev-training(紫)にする)。取消が来ない場合でも
  // 各カテゴリの安全策TTLで自動的に消える
  if (report.report_classification_no === 7 && !showTrainingBroadcasts) return;

  if (report.type === 'DecodeError') {
    addActiveEvent({
      isTestData: !!report.is_test_data,
      badgeText: 'エラー',
      badgeClass: 'report-badge sev-error',
      title: '⚠️ デコードに失敗しました',
      meta: report.sentence || '',
      rows: [],
      geo: { hypocenter: null, tsunami: [], prefectures: [] },
      bounds: null,
      isTransientNotice: true,
    }, 10000); // 技術的なエラー通知なので短時間で消す
    return;
  }

  if (report.type === 'QzssDcxJAlert') {
    if (report.a1_message_type === 'All Clear') {
      const key = jalertMatchKey(report);
      for (const [id, record] of activeEvents) {
        if (record.jalertKey === key) removeActiveEvent(id);
      }
      return;
    }
    const event = applyTrainingLabel(buildEventFromJAlert(report), report);
    if (isRelevantToTargetRegion(event)) addActiveEvent(event, TTL_JALERT_MS);
    return;
  }

  if (report.type === 'QzssDcxLAlert') {
    if (report.a1_message_type === 'All Clear') {
      const key = lalertMatchKey(report);
      for (const [id, record] of activeEvents) {
        if (record.lalertKey === key) removeActiveEvent(id);
      }
      return;
    }
    const event = applyTrainingLabel(buildEventFromLAlert(report), report);
    if (isRelevantToTargetRegion(event)) addActiveEvent(event, lalertTtlMs(report));
    return;
  }

  // 気象警報・注意報(10): 1通報に複数の地域コードが同時に含まれ、かつ
  // 地域ごとに個別解除されうるため、activeEventsとは別のMapで地域コード
  // 単位に管理する
  if (report.disaster_category_no === 10) {
    const codes = report.weather_forecast_regions_raw || [];
    const names = report.weather_forecast_regions || [];
    const subCats = report.weather_related_disaster_sub_categories || [];
    const resolved = report.information_type_no === 2 || report.weather_warning_state === '解除';
    const newlyAddedCodes = [];
    let removedFocusedRegion = false;
    codes.forEach((code, i) => {
      if (resolved) {
        const existing = weatherSites.get(code);
        if (existing && existing.timer) clearTimeout(existing.timer);
        if (weatherSites.delete(code) && currentPatrolCode === code) removedFocusedRegion = true;
        return;
      }
      // デバイスロックモードでは、地域コード上位2桁(都道府県ID、
      // regionDisplayNameと同じ導出方法)が対象地域外なら追加しない
      if (lockedPrefectureIds && !lockedPrefectureIds.has(Math.floor(code / 10000))) return;
      const existing = weatherSites.get(code);
      if (!existing) newlyAddedCodes.push(code);
      if (existing && existing.timer) clearTimeout(existing.timer);
      const subCategory = subCats[i];
      const mergedSubCategories = existing
        ? [...new Set([...existing.subCategories, subCategory].filter(Boolean))]
        : [subCategory].filter(Boolean);
      const rawName = names[i] || (existing && existing.rawName) || String(code);
      const feature = weatherFeaturesByCode.get(code);
      weatherSites.set(code, {
        code,
        rawName, // 地域名の無い再送時に existing.rawName で引き継ぐため保存必須
        name: (report.report_classification_no === 7 ? '[訓練] ' : '') + regionDisplayName(code, rawName),
        subCategories: mergedSubCategories,
        description: report.description || (existing && existing.description) || '',
        bounds: feature ? geometryBounds(feature.geometry) : (existing && existing.bounds) || null,
        isTestData: !!report.is_test_data,
        satelliteId: report.satellite_id,
        satellitePrn: report.satellite_prn,
        updatedAt: Date.now(),
        // 解除信号が届かなかった場合の安全策。更新の度にリセットされる
        timer: setTimeout(() => expireWeatherSite(code), TTL_WEATHER_MS),
      });
    });
    updateWeatherDisplay();
    syncActiveEventLayers();
    renderEventsPanel();
    // 新しい地域が増えた場合: 巡回が休止中ならすぐ起動し、既に巡回中なら
    // 順番を待たずその新しい地域へ割り込んでズームする(複数箇所が
    // 同時にアクティブでも、新しく発表された方を優先して見せるため)
    // 新しい地域の警報は、巡回中・休止中・重要イベント表示中を問わず
    // すぐ割り込みズームで見せる(その後は通常の巡回/重要イベントに復帰)
    if (newlyAddedCodes.length) interruptPatrolForNewRegion(newlyAddedCodes[0]);
    // 巡回中に表示していた地域が解除された場合は、すぐ次の地域へ進める
    if (removedFocusedRegion) schedulePatrolNext(0);
    return;
  }

  // 台風(12)は表示しない(暴風域を正確に描く手がかりが無く、取消信号も
  // 来ないため、表示し続けると誤解を招く懸念がある)

  // 南海トラフ地震(4)・火山(8)・降灰(9)・洪水(11): カテゴリごとに1枚
  if ([4, 8, 9, 11].includes(report.disaster_category_no)) {
    const existing = otherReports.get(report.disaster_category_no);
    if (existing && existing.timer) clearTimeout(existing.timer);
    if (report.information_type_no === 2) {
      otherReports.delete(report.disaster_category_no);
    } else {
      const event = applyTrainingLabel(buildEventFromOtherCategory(report), report);
      // 解除信号が届かなかった場合の安全策。更新の度にリセットされる
      event.timer = setTimeout(() => {
        otherReports.delete(report.disaster_category_no);
        renderEventsPanel();
      }, TTL_OTHER_CATEGORY_MS);
      otherReports.set(report.disaster_category_no, event);
    }
    renderEventsPanel();
    return;
  }

  // キャンセル報(取消)は種別を問わず優先的に処理する(絞り込みの影響を受けない)
  if (report.information_type_no === 2) {
    handleCancellation(report);
    return;
  }

  // 津波警報の解除・「津波なし」は危険な状況が収束したサインなので、
  // 画面をリセットする(取消と同様、絞り込みの影響を受けない)
  if (report.disaster_category_no === 5 && [1, 2].includes(report.tsunami_warning_code_raw)) {
    handleTsunamiResolution(report);
    return;
  }

  // 緊急地震速報・震源・震度速報・津波関連 以外は重要度が低いため
  // 画面はそのまま(前回の重要な通報の表示を維持する)
  if (!ALLOWED_CATEGORIES.has(report.disaster_category_no)) return;

  const event = applyTrainingLabel(buildEventFromReport(report), report);
  if (!isRelevantToTargetRegion(event)) return;

  // 立て続けの地震(余震)対応: 新しい緊急地震速報が届いた時、既に表示中の
  // 近隣の地震イベント(前の地震の震度速報など)が残っていると、古い震度の
  // 塗りつぶしと新しい速報の塗りつぶしが混ざって紛らわしい。同じ地震
  // グループ、または地理的に近い既存の地震イベントは一旦取り下げて、
  // 最新の緊急地震速報の表示に切り替える
  if (report.disaster_category_no === 1) {
    for (const [id, record] of [...activeEvents]) {
      if (![1, 2, 3].includes(record.disasterCategoryNo)) continue;
      const sameGroup =
        (record.epicenterRaw != null && record.epicenterRaw === report.seismic_epicenter_raw) ||
        (record.occurrenceTime && record.occurrenceTime === report.occurrence_time_of_earthquake);
      const near = event.bounds && record.bounds && boundsAreNear(event.bounds, record.bounds);
      if (sameGroup || near) removeActiveEvent(id);
    }
    addActiveEvent(event, report.is_test_data ? TTL_TEST_DATA_MS : TTL_EEW_MS);
    return;
  }

  const match = findMatchingGroup(report, event);
  const ttlMs = ttlMsForReport(report);
  if (match) mergeIntoActiveEvent(match, event, report, ttlMs);
  else addActiveEvent(event, ttlMs);
}

// ==================================================
// 地図初期化
// ==================================================
// ==================================================
// 地図初期化(段階的ロード)
//
// ラズパイ等の非力な端末でも「表示可能になるまで」を短くするため、
// 全データを1つのPromise.allで待ってから一気に描画するのではなく、
// 優先度順に3段階に分けて読み込む:
//   段階0: style.json だけ(地図を作るのに必須。これ以外は待たない)
//   段階1: 警報エリアの描画に直結するデータ(都道府県・津波沿岸・
//          気象警報区域)。ここまでで「警報が出たら塗って見せる」が
//          一通り揃う
//   段階2: 使用頻度が低い/無くても致命的ではないデータ(震央地名の
//          座標変換テーブル、市区町村ポリゴン)。地図表示後に
//          バックグラウンドで読み込み、揃い次第反映する
// ==================================================
async function initMap() {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  // 段階0: 地図の生成に必須なstyle.jsonだけを待つ
  const style = await fetch('./style.json').then(res => {
    if (!res.ok) throw new Error('style.json の読み込みに失敗');
    return res.json();
  });

  const bounds = [[JAPAN_VICINITY_BOUNDS[0], JAPAN_VICINITY_BOUNDS[1]], [JAPAN_VICINITY_BOUNDS[2], JAPAN_VICINITY_BOUNDS[3]]];
  const initialView = getDefaultView();
  map = new maplibregl.Map({
    container: 'map',
    style: style,
    center: initialView.center,
    zoom: initialView.zoom,
    minZoom: MAP_MIN_ZOOM,
    // 対象地域の把握にそこまでの拡大は不要なため上限を下げる
    // (ローカルキオスク・公開Web版どちらも実機/実際の操作感で確認した値)
    maxZoom: 9,
    maxBounds: bounds,
    // Pi 3等の非力なGPU向けの描画負荷軽減。見た目への影響はほぼ無い
    // (フェード遷移が無くなる程度)が、毎フレームの合成コストを削れる
    fadeDuration: 0,
    refreshExpiredTiles: false,
    // ラズパイのkiosk表示にはマウス・タッチ操作をする人がいないため、
    // ドラッグ/ズーム/回転等の操作ハンドラ自体を無効化し、イベント
    // リスナー登録・ジェスチャー判定のオーバーヘッドを無くす。
    // 一般公開ページ(eq.shum10.com)の閲覧者には影響しない
    interactive: !IS_LOCAL_KIOSK,
  });

  await new Promise(resolve => map.on('load', resolve));

  // モバイルではアドレスバー/ツールバーの表示・非表示で実際のビューポート高さが
  // 変わるが、maplibre-glはコンテナのCSSサイズ変更を自動検知しないため、
  // canvas自体が古いサイズのまま残り下部が空白になることがある。
  // ResizeObserverでコンテナのサイズ変化を検知し、明示的にresize()する。
  const mapContainer = document.getElementById('map');
  if (mapContainer && 'ResizeObserver' in window) {
    new ResizeObserver(() => map.resize()).observe(mapContainer);
  }

  // ズーム操作/オートズームに合わせて震度バッジの大きさを追従させる
  map.on('zoom', updateAllIntensityBadgeScales);

  // 段階1: 警報エリアの表示に直結するデータを並行取得(3つ合計でも
  // 市区町村データ1つより軽い)。届き次第すぐにレイヤーを追加する
  const [tsunamiGeoJSON, prefectureGeoJSON, weatherRegionsGeoJSON] = await Promise.all([
    fetch('./data/tsunami_regions.geojson').then(res => res.json()),
    fetch('./data/prefectures.geojson').then(res => res.json()),
    fetch('./data/weather_regions.geojson').then(res => res.json()),
  ]);

  for (const f of tsunamiGeoJSON.features) tsunamiFeaturesByCode.set(f.properties.code, f);
  for (const f of prefectureGeoJSON.features) {
    prefectureFeaturesById.set(f.properties.id, f);
    prefectureFeaturesByName.set(f.properties.name, f);
  }
  for (const f of weatherRegionsGeoJSON.features) weatherFeaturesByCode.set(f.properties.code, f);

  // 国土地理院のベクトルタイルはzoom4未満だとタイルデータ自体が存在せず
  // 真っ白になる。都道府県ポリゴン(prefectures.geojson)を使った境界線
  // だけの簡易表示を「行政区画」レイヤーの直下に挿入しておくことで、
  // タイルが無いズームレベルでも最低限の日本の形は表示され続けるように
  // する(地名・道路・鉄道等は一切載せない)。
  map.addSource('fallback-landmass', { type: 'geojson', data: prefectureGeoJSON });
  map.addLayer(
    {
      id: 'fallback-landmass-fill',
      type: 'fill',
      source: 'fallback-landmass',
      // 注意: 以前ここに maxzoom:5(本物のタイルに隠れて見えないので
      // 打ち切る)という「軽量化」を入れたが、実際には下地のpmtiles
      // (base_slim_final.pmtiles)自体の実データがzoom7までしか無く、
      // それを超えるズームでオーバーズーム表示が効かない/効きが悪い
      // ケースがあり、結果としてzoom5〜7超で背景が何も描画されない
      // (対象エリア以外が真っ暗)不具合を起こした。塗り自体は軽い
      // 処理なので、無効化はせず常時描画に戻す
      paint: { 'fill-color': 'rgba(140,140,140,1)' },
    },
    '行政区画'
  );

  map.addSource('tsunami-regions', { type: 'geojson', data: tsunamiGeoJSON });
  map.addLayer({
    id: 'tsunami-line',
    type: 'line',
    source: 'tsunami-regions',
    filter: ['in', ['get', 'code'], ['literal', []]],
    paint: {
      'line-color': TSUNAMI_DEFAULT_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 10],
    },
  });

  map.addSource('prefecture-regions', { type: 'geojson', data: prefectureGeoJSON });
  map.addLayer({
    id: 'prefecture-fill',
    type: 'fill',
    source: 'prefecture-regions',
    filter: ['in', ['get', 'id'], ['literal', []]],
    paint: { 'fill-color': '#999999', 'fill-opacity': 0.6 },
  });
  map.addLayer({
    id: 'prefecture-outline',
    type: 'line',
    source: 'prefecture-regions',
    filter: ['in', ['get', 'id'], ['literal', []]],
    paint: { 'line-color': 'rgba(0,0,0,0.6)', 'line-width': 1.5 },
  });

  // Lアラート用: 都道府県よりも精密な円/楕円形の対象範囲(中心緯度経度+
  // 半径)を描画する。都道府県名で塗れないケース(市区町村単位・任意の
  // 円形範囲)に対応するため、prefecture-fillとは別のGeoJSONソースにする。
  // 中身は空でも軽いので、警報エリア系のレイヤーと一緒にここで追加する
  map.addSource('lalert-ellipses', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'lalert-ellipse-fill',
    type: 'fill',
    source: 'lalert-ellipses',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'lalert-ellipse-line',
    type: 'line',
    source: 'lalert-ellipses',
    paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
  });

  // 気象警報・注意報の対象地域(一次細分区域)
  map.addSource('weather-regions', { type: 'geojson', data: weatherRegionsGeoJSON });
  map.addLayer({
    id: 'weather-fill',
    type: 'fill',
    source: 'weather-regions',
    filter: ['in', ['get', 'code'], ['literal', []]],
    paint: { 'fill-color': WEATHER_WARNING_COLOR, 'fill-opacity': 0.5 },
  });
  map.addLayer({
    id: 'weather-outline',
    type: 'line',
    source: 'weather-regions',
    filter: ['in', ['get', 'code'], ['literal', []]],
    paint: { 'line-color': WEATHER_WARNING_COLOR, 'line-width': 1.5 },
  });
  // 巡回でズームインしている対象地域の輪郭を白い太線で強調する
  // (どこの話をしているのかが一目で分かるように)
  map.addLayer({
    id: 'weather-focus-outline',
    type: 'line',
    source: 'weather-regions',
    filter: ['in', ['get', 'code'], ['literal', []]],
    paint: { 'line-color': '#ffffff', 'line-width': 4 },
  });

  // ここまでで地図本体(日本の形・警報エリアを塗れる状態)の描画が
  // 完了している。デバイスロック・訓練放送設定は地図の見た目そのもの
  // ではなく付随設定なので、地図が画面に出た後に読み込む(体感の
  // 起動速度優先: 「まず地図、その後にパネル/設定」の順にする)
  await applyDeviceRegionLock();
  await loadShowTrainingBroadcastsSetting();

  // 段階2: 使用頻度が低い/主要な情報表示に必須ではないデータは、ここまでの
  // 「警報エリアを塗れる」状態が整った後に、バックグラウンドで読み込む。
  // await しない(=呼び出し元のinitMap完了を待たせない)ことで、地図の
  // 初回表示・操作可能になるタイミングを優先する。
  // 市区町村ポリゴン(一番重いデータ)は、ここでは読み込まない。
  // Lアラート(市区町村指定)が実際に届いた時に初めて読み込む
  // (buildEventFromLAlert参照)。多くのセッションでは一度も必要と
  // ならないデータなので、常に先読みするのは無駄になりやすい
  loadEpicenterLookupTable();

  // 気象警報の巡回ループを開始する(最初は警報が無いはずなので、
  // 実質的に「定期的に確認するだけ」の待機状態から始まる)
  schedulePatrolNext(PATROL_DWELL_MS);
}

// 震央地名コード→中心座標のルックアップテーブル。EEW速報等で座標が
// 直接含まれない場合の✕マーカー位置決めにのみ使う(地図レイヤーとしては
// 描画しない)。ほとんどの実際の通報はcoordinates_of_hypocenterに生の
// 座標を持つため、これが無くても大半のケースは表示できる=優先度低
async function loadEpicenterLookupTable() {
  try {
    const res = await fetch('./data/epicenter_regions.geojson');
    const epicenterGeoJSON = await res.json();
    for (const f of epicenterGeoJSON.features) epicenterFeaturesById.set(f.properties.id, f);
  } catch (err) {
    console.error('震央地名データの読み込みに失敗しました:', err);
  }
}

let municipalityLayerLoaded = false;

async function loadMunicipalityLayer() {
  if (municipalityLayerLoaded) return;
  try {
    // ローカルキオスクは最大ズームを抑えているため(9)、市区町村境界を
    // より簡略化した専用データで十分(細部が見えるほど寄れない)
    const res = await fetch(IS_LOCAL_KIOSK ? './data/municipalities_kiosk.geojson' : './data/municipalities.geojson');
    const municipalityGeoJSON = await res.json();
    // Lアラートの市区町村コード(ex1)は「全国地方公共団体コード」(JIS X0402、
    // 先頭0埋め5桁)そのものなので、国土数値情報(N03)の行政区域データを
    // 同じコードで直接紐付けられる(名前でのあいまい一致は不要)
    for (const f of municipalityGeoJSON.features) municipalityFeaturesByCode.set(f.properties.code, f);
    if (!map.getSource('municipality-regions')) {
      // 全国約1900件をまるごとソースに入れるとMapLibre内部でのタイル化
      // コストが常時かかり続けるため、ソース自体は空で作り、実際に
      // 対象になった市区町村だけをsyncActiveEventLayersがsetDataで
      // 都度入れる(ルックアップ用のmunicipalityFeaturesByCodeとは別)
      map.addSource('municipality-regions', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'municipality-fill',
        type: 'fill',
        source: 'municipality-regions',
        filter: ['in', ['get', 'code'], ['literal', []]],
        paint: { 'fill-color': '#999999', 'fill-opacity': 0.6 },
      });
      map.addLayer({
        id: 'municipality-outline',
        type: 'line',
        source: 'municipality-regions',
        filter: ['in', ['get', 'code'], ['literal', []]],
        paint: { 'line-color': 'rgba(0,0,0,0.6)', 'line-width': 1.5 },
      });
    }
    municipalityLayerLoaded = true;
    // 読み込み完了より前にLアラート(市区町村指定)が届いていた場合、
    // その時点ではポリゴンが見つからず塗りを諦めていたので、今読み
    // 込んだデータで改めて解決を試みる
    for (const record of activeEvents.values()) {
      if (!record.pendingMunicipalityCode || record.geo.municipality) continue;
      const feature = municipalityFeaturesByCode.get(record.pendingMunicipalityCode);
      if (!feature) continue;
      record.geo.municipality = { code: record.pendingMunicipalityCode, color: record.lalertColor };
      const featureBounds = geometryBounds(feature.geometry);
      record.bounds = record.bounds ? unionBounds([record.bounds, featureBounds]) : featureBounds;
      record.pendingMunicipalityCode = null;
    }
    syncActiveEventLayers();
    updateCameraForActiveEvents(null);
  } catch (err) {
    console.error('市区町村データの読み込みに失敗しました:', err);
  }
}

const mapReady = initMap().catch(err => {
  console.error(err);
  alert('地図の初期化に失敗しました: ' + err.message);
});

// ==================================================
// WebSocket通信
// ==================================================
// server.js が静的配信・WebSocket・/ingest をすべて同じポートで
// 提供するため、ページを読み込んだのと同じオリジンに接続する
// (ローカルでもCloud Run上でもポート指定なしで動く)
// 接続が切れた場合は自動的に再接続を試みる(実機運用で長時間
// タブを開きっぱなしにしても復帰できるようにするため)
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

function connectWebSocket() {
  const socket = new WebSocket(`${wsProtocol}//${location.host}`);

  socket.addEventListener('open', () => {
    console.log('✅ WebSocket接続できました');
    updateConnectionStatus('online');
    clearAllActiveEvents();
  });

  socket.addEventListener('error', (err) => {
    console.error('❌ WebSocketエラー:', err);
  });

  socket.addEventListener('close', () => {
    console.warn('WebSocket切断、3秒後に再接続します');
    updateConnectionStatus('reconnecting');
    setTimeout(connectWebSocket, 3000);
  });

  socket.addEventListener('message', async (event) => {
    console.log('ブラウザ受信:', event.data);

    let report;
    try {
      report = JSON.parse(event.data);
    } catch (e) {
      console.warn('JSONとして解釈できないメッセージを受信:', event.data);
      return;
    }

    if (report.type === 'Heartbeat') {
      lastHeartbeatTime = Date.now();
      noteSatelliteReceived(report);
      refreshStatusPill();
      return;
    }

    noteSatelliteReceived(report);

    await mapReady;
    renderReport(report);

    // レイテンシ計測(T0受信〜T4描画完了)。renderReportは同期関数で、
    // 警報の塗りつぶし(最優先の描画)はこの時点で既に反映済みのため、
    // ここでのDate.now()がT4として妥当。サーバーへ返して1箇所のログに
    // まとめる(受信機・サーバー・ブラウザで別々に見なくて済むように)
    if (report.client_timestamps) {
      const t4 = Date.now();
      // sentence/raw/message/nmeaは同じ信号の別エンコーディングに過ぎず
      // ダッシュボードでの内容確認には不要なので除外する(このためだけに
      // ペイロードを膨らませたくない)
      const { sentence, raw, message, nmea, client_timestamps, ...reportSummary } = report;
      const timestamps = {
        ...report.client_timestamps,
        t4_rendered_ms: t4,
        isTestData: !!report.is_test_data,
        reportSummary,
      };
      fetch('/client-timing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(timestamps),
      }).catch(() => {});
    }
  });
}

connectWebSocket();

// ==================================================
// PWA: Service Worker登録(ホーム画面追加・オフラインでの見た目表示用)
// ==================================================
let swRegistration = null;
// ローカルキオスクはホーム画面追加もプッシュ通知も使わないため、
// Service Worker登録自体を省略する(インストール・キャッシュ管理の
// バックグラウンド処理が無くなる分、非力な端末には軽くなる)
if ('serviceWorker' in navigator && !IS_LOCAL_KIOSK) {
  window.addEventListener('load', async () => {
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js');
      initPushNotificationButton();
    } catch (err) {
      console.warn('Service Workerの登録に失敗しました:', err);
    }
  });
}

// ==================================================
// プッシュ通知
// iOSでは「ホーム画面に追加したPWA」からのユーザー操作(ボタン押下)を
// 起点にした購読リクエストが必須なため、自動購読はせずボタンで行う。
// ==================================================
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function initPushNotificationButton() {
  const button = document.getElementById('notify_button');
  if (!button) return;

  if (IS_LOCAL_KIOSK) {
    button.style.display = 'none';
    return;
  }

  if (!('PushManager' in window) || !swRegistration) {
    button.disabled = true;
    button.title = 'この環境ではプッシュ通知に対応していません';
    return;
  }

  const existing = await swRegistration.pushManager.getSubscription();
  updateNotifyButton(button, !!existing);

  button.addEventListener('click', async () => {
    const current = await swRegistration.pushManager.getSubscription();
    if (current) {
      await unsubscribePush(current);
      updateNotifyButton(button, false);
      return;
    }
    const ok = await subscribePush();
    updateNotifyButton(button, ok);
  });
}

function updateNotifyButton(button, isOn) {
  button.textContent = isOn ? '通知ON' : '通知OFF';
  button.classList.toggle('notify-on', isOn);
  button.title = isOn ? '通知ON' : '通知OFF';
}

async function subscribePush() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('通知が許可されませんでした。端末の設定から通知を許可してください。');
      return false;
    }
    const res = await fetch('./push/vapid-public-key');
    const { publicKey, enabled } = await res.json();
    if (!enabled || !publicKey) {
      alert('サーバー側でプッシュ通知が設定されていません。');
      return false;
    }
    const subscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch('./push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });
    return true;
  } catch (err) {
    console.error('プッシュ通知の購読に失敗しました:', err);
    alert('通知の設定に失敗しました: ' + err.message);
    return false;
  }
}

async function unsubscribePush(subscription) {
  try {
    await fetch('./push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  } catch (err) {
    console.error('プッシュ通知の解除に失敗しました:', err);
  }
}

// ==================================================
// キオスク表示向け: マウスカーソルを一定時間動かさなかったら隠す
// (操作する人がいない常設ディスプレイで、カーソルが映ったままだと
// 見栄えが悪いため)。一般公開ページの通常の閲覧者には影響しないよう、
// ローカルキオスク(localhostアクセス)限定にする。
// なお実機(Pi、labwc)ではこのCSSベースの非表示は効かなかった
// (カーソルがWayland/XWayland compositor側の描画のため、ページの
// CSSでは制御できない)。実機側はunclutter-xfixesで別途対応済みだが、
// 将来他のOS/ブラウザでkiosk表示する場合の保険として残しておく
// ==================================================
if (IS_LOCAL_KIOSK) {
  const CURSOR_HIDE_DELAY_MS = 3000;
  let cursorHideTimer = null;
  const resetCursorHideTimer = () => {
    document.body.classList.remove('cursor-hidden');
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      document.body.classList.add('cursor-hidden');
    }, CURSOR_HIDE_DELAY_MS);
  };
  document.addEventListener('mousemove', resetCursorHideTimer);
  resetCursorHideTimer();
}
