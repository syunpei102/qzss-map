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
    statusEl.textContent = '🔴 オフライン';
    statusEl.className = 'status-pill status-offline';
    if (satelliteEl) satelliteEl.textContent = '';
    return;
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

function flyToBounds(bounds, pad = 24, maxZoomOverride = null) {
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
      duration: 800,
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
  if (report.information_type && report.information_type !== '発表') {
    return `${report.disaster_category}(${report.information_type})`;
  }
  return report.disaster_category || report.type;
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

  if (!rows.length && Array.isArray(report.notifications_on_disaster_prevention) && report.notifications_on_disaster_prevention.length) {
    push('内容', report.notifications_on_disaster_prevention[0].split('\n')[0]);
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
    boundsList.push(geometryBounds(feature.geometry));
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
        // 市区町村レイヤーはバックグラウンドで遅延読み込みしているため、
        // まだ読み込みが終わっていないタイミングで届くと該当ポリゴンが
        // 見つからないことがある。コードだけ覚えておき、読み込み完了後に
        // loadMunicipalityLayer側で改めて塗りを反映する
        pendingMunicipalityCode = code;
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
    rows: (report.description || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 1).map((l) => ['内容', l]),
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
const WEATHER_PATROL_MAX_ZOOM = 8;

function zoomToWeatherCode(code) {
  const feature = weatherFeaturesByCode.get(code);
  if (!feature) return;
  flyToBounds(geometryBounds(feature.geometry), 40, WEATHER_PATROL_MAX_ZOOM);
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

function patrolStep() {
  // activeEvents(地震・津波・Jアラート・Lアラート等)がある間は、
  // そちらの表示を優先する。カメラは動かさず、少し後にまた確認する
  if (activeEvents.size > 0) {
    schedulePatrolNext(PATROL_DWELL_MS);
    return;
  }

  const codes = [...weatherSites.keys()];
  if (!codes.length) {
    if (currentPatrolCode !== null) {
      currentPatrolCode = null;
      updateFocusOutline();
      renderEventsPanel();
      const view = getDefaultView();
      map.easeTo({ center: view.center, zoom: view.zoom, duration: 1000 });
    }
    patrolIndex = 0;
    schedulePatrolNext(PATROL_DWELL_MS); // 警報が出ていないか定期的に確認する
    return;
  }

  if (patrolIndex >= codes.length) {
    // 一通り巡回し終えたので、いったん全体表示に戻して休止する
    patrolIndex = 0;
    currentPatrolCode = null;
    const view = getDefaultView();
    map.easeTo({ center: view.center, zoom: view.zoom, duration: 1000 });
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
  if (currentPatrolCode === null && weatherSites.size > 0 && activeEvents.size === 0) {
    schedulePatrolNext(0);
  }
}

// 巡回中に別の地域の警報・注意報が新しく発表された場合、次の巡回の
// 順番を待たず、その新しい地域をすぐズームインして見せる。
// 見せ終わったら通常の巡回に戻る(codes配列内での位置を追跡し直し、
// 他の地域を飛ばしたり、同じ地域をすぐ繰り返したりしないようにする)
function interruptPatrolForNewRegion(code) {
  if (activeEvents.size > 0) return; // 地震等が優先中なら割り込まない
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
      if (centroid) geo.hypocenter = { lon: centroid[0], lat: centroid[1], label: feature.properties.name };
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
      if (feature) boundsList.push(geometryBounds(feature.geometry));
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
      if (feature) boundsList.push(geometryBounds(feature.geometry));
    });
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

function getDefaultView() {
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
      if (epicenterRaw != null && record.epicenterRaw === epicenterRaw) return record;
      if (occurrenceTime != null && record.occurrenceTime === occurrenceTime) return record;
    }
    return null;
  }

  const RECENT_MS = 5 * 60 * 1000;
  const now = Date.now();
  let best = null;
  for (const record of activeEvents.values()) {
    if (now - record.updatedAt > RECENT_MS) continue;
    if (eventData.bounds && record.bounds && !boundsAreNear(eventData.bounds, record.bounds)) continue;
    if (!best || record.updatedAt > best.updatedAt) best = record;
  }
  return best;
}

function createHypocenterMarkers(hypocenter) {
  const markers = { hypocenter: null, hypocenterLabel: null };
  const { lon, lat, label } = hypocenter;
  markers.hypocenter = new maplibregl.Marker({ element: createCrossMarkerElement(), anchor: 'center' })
    .setLngLat([lon, lat])
    .addTo(map);
  if (label) {
    const el = document.createElement('div');
    el.className = 'epicenter-label';
    el.textContent = label;
    markers.hypocenterLabel = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -18] })
      .setLngLat([lon, lat])
      .addTo(map);
  }
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

  if (record.geo.hypocenter) Object.assign(record.markers, createHypocenterMarkers(record.geo.hypocenter));
  record.markers.intensityBadges = createIntensityBadgeMarkers(record.geo.prefectures);

  record.timer = ttlMs ? setTimeout(() => removeActiveEvent(id), ttlMs) : null;
  activeEvents.set(id, record);
  // 地震・津波・Jアラート・Lアラート等が発生した場合、地図はそちらに
  // ズームするため、それまで気象警報の巡回で表示していた地域の
  // カード/輪郭強調は(カメラが実際にはもうそこを見ていないので)消す
  if (currentPatrolCode !== null) {
    currentPatrolCode = null;
    updateFocusOutline();
  }
  syncActiveEventLayers();
  updateCameraForActiveEvents(record);
  renderEventsPanel();
}

// 既にアクティブな同一地震のイベントに、新しい通報の内容を統合する
// (震源位置の更新で✕マーカーが重複しないよう差し替え、都道府県の
//  塗りつぶし・詳細項目は最新の内容で上書きしつつ足りないものは追加する)
function mergeIntoActiveEvent(record, eventData, report) {
  clearTimeout(record.timer);

  if (eventData.geo.hypocenter) {
    if (record.markers.hypocenter) record.markers.hypocenter.remove();
    if (record.markers.hypocenterLabel) record.markers.hypocenterLabel.remove();
    Object.assign(record.markers, createHypocenterMarkers(eventData.geo.hypocenter));
    record.geo.hypocenter = eventData.geo.hypocenter;
  }

  // 都道府県の塗りつぶしは「統合」ではなく「置き換え」にする。
  // 例えば緊急地震速報(予報区ベースの広い赤塗り)のあとに震度速報
  // (実際に観測された震度)が来た場合、震度速報の対象外の県にまで
  // 赤塗りが残り続けるのを防ぐため、新しい情報を持つ通報が来たら
  // 都道府県リストはその内容で丸ごと置き換える(情報を持たない
  // 通報、例えば震源に関する情報は何もしない=前の表示を維持する)
  if (eventData.geo.prefectures.length) {
    record.geo.prefectures = eventData.geo.prefectures;
    for (const marker of record.markers.intensityBadges) marker.remove();
    record.markers.intensityBadges = createIntensityBadgeMarkers(record.geo.prefectures);
  }

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
  if (typeof report.seismic_epicenter_raw === 'number') record.epicenterRaw = report.seismic_epicenter_raw;
  if (report.occurrence_time_of_earthquake) record.occurrenceTime = report.occurrence_time_of_earthquake;
  record.updatedAt = Date.now();

  record.timer = record.ttlMs ? setTimeout(() => removeActiveEvent(record.id), record.ttlMs) : null;
  syncActiveEventLayers();
  // 更新された(続報が来た)イベントも「新しく発表された方」として扱い、
  // そちらを優先してズームする
  updateCameraForActiveEvents(record);
  renderEventsPanel();
}

function removeActiveEvent(id) {
  const record = activeEvents.get(id);
  if (!record) return;
  if (record.markers.hypocenter) record.markers.hypocenter.remove();
  if (record.markers.hypocenterLabel) record.markers.hypocenterLabel.remove();
  for (const marker of record.markers.intensityBadges) marker.remove();
  activeEvents.delete(id);
  syncActiveEventLayers();
  // 何を優先すべきか特に無い(消えた側なので)。残っている全体を
  // 見せるか、何も残っていなければ通常の待機表示に戻す
  updateCameraForActiveEvents(null);
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
    if (municipalityColorByCode.size) {
      const matchExpr = ['match', ['get', 'code']];
      for (const [code, color] of municipalityColorByCode) matchExpr.push(code, color);
      matchExpr.push('rgba(0,0,0,0)');
      map.setFilter('municipality-fill', ['in', ['get', 'code'], ['literal', [...municipalityColorByCode.keys()]]]);
      map.setFilter('municipality-outline', ['in', ['get', 'code'], ['literal', [...municipalityColorByCode.keys()]]]);
      map.setPaintProperty('municipality-fill', 'fill-color', matchExpr);
    } else {
      map.setFilter('municipality-fill', ['in', ['get', 'code'], ['literal', []]]);
      map.setFilter('municipality-outline', ['in', ['get', 'code'], ['literal', []]]);
    }
  }

}

// カメラ位置を決める。preferredRecord を渡すと「今まさに新規追加/更新された
// イベント」を最優先でズーム表示する(複数箇所が同時にアクティブでも、
// 新しく発表された方が見える、という挙動のため)。ただし津波警報が
// 出ている間は、何が新しく届いたかによらず津波の対象沿岸を最優先で見せる
// (人命に関わる優先度が最も高いため)。
function updateCameraForActiveEvents(preferredRecord) {
  if (!map) return;

  let tsunamiActive = false;
  const tsunamiBoundsList = [];
  for (const record of activeEvents.values()) {
    if (!record.tsunamiWarningActive) continue;
    tsunamiActive = true;
    for (const t of record.geo.tsunami) {
      const feature = tsunamiFeaturesByCode.get(t.code);
      if (feature) tsunamiBoundsList.push(geometryBounds(feature.geometry));
    }
  }
  if (tsunamiActive && tsunamiBoundsList.length) {
    flyToBounds(unionBounds(tsunamiBoundsList), 16);
    return;
  }

  // 明示的な優先イベントが指定されていない場合(再接続時の一括再送や、
  // 市区町村データの遅延読み込み完了時など)は、直近に更新されたイベントを
  // 優先候補として補う。これが無いと「誰が新しいか分からないので全部
  // union fitする」しかできず、例えば札幌と那覇のLアラートが両方
  // 保留から同時に解決した時に、日本全体を映す中途半端なズームになって
  // しまう(実際に発生を確認して修正した)
  if (!preferredRecord) {
    let latest = null;
    for (const record of activeEvents.values()) {
      if (record.bounds && (!latest || record.updatedAt > latest.updatedAt)) latest = record;
    }
    preferredRecord = latest;
  }

  if (preferredRecord && preferredRecord.bounds) {
    flyToBounds(preferredRecord.bounds, 24);
    return;
  }

  // 気象警報(weatherSites)はここには含めない。気象警報のカメラ制御は
  // 巡回(patrolStep/interruptPatrolForNewRegion)が専任で行うため、
  // ここで一緒にunion fitしてしまうと、巡回とカメラを取り合ってしまう。
  // (ここに到達するのは、活動中のイベントが1件もboundsを持たない
  // 稀なケースのみ)
  const boundsList = [];
  for (const record of activeEvents.values()) {
    if (record.bounds) boundsList.push(record.bounds);
  }
  if (boundsList.length) {
    // オートズーム: アクティブな全イベントが収まるようにズームアウト/フィット
    // (パディングを詰めて、対象地域によりズームインする)
    flyToBounds(unionBounds(boundsList), 24);
  } else if (currentPatrolCode === null) {
    // 何もアクティブでなく、気象警報の巡回もしていなければ日本全体表示に戻す。
    // 巡回中(currentPatrolCode有り)は、そちらがカメラを管理しているので
    // ここでは何もしない(勝手にリセットして巡回とカメラの取り合いに
    // ならないようにする)
    const view = getDefaultView();
    map.easeTo({ center: view.center, zoom: view.zoom, duration: 1200 });
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

  const focusedWeatherSite = currentPatrolCode !== null ? weatherSites.get(currentPatrolCode) : null;
  const visibleRecords = [
    ...activeEvents.values(),
    ...(focusedWeatherSite ? [weatherSiteCard(focusedWeatherSite)] : []),
    ...[...otherReports.values()].map(otherReportCard),
  ];

  if (!visibleRecords.length) {
    container.innerHTML = `
      <div class="report-card">
        <div class="report-badge">待機中</div>
        <div class="report-title">受信を待っています…</div>
      </div>`;
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
    },
    10000
  );
}

// ==================================================
// 表示地域の絞り込み(管理画面 admin.html で登録した都道府県のみ表示)
// 未登録(null)なら絞り込みなし。対象都道府県が判別できない通報
// (震源のみの情報・津波情報など geo.prefectures が空のもの)は
// 絞り込み対象外として常に表示する。
// ==================================================
const TARGET_PREFECTURES_KEY = 'qzss_target_prefectures';

function getTargetPrefectureIds() {
  try {
    const raw = localStorage.getItem(TARGET_PREFECTURES_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? new Set(arr) : null;
  } catch (e) {
    return null;
  }
}

function isRelevantToTargetRegion(eventData) {
  const targetIds = getTargetPrefectureIds();
  if (!targetIds) return true; // 絞り込み未設定
  if (!eventData.geo.prefectures.length) return true; // 対象都道府県が不明な通報は常に表示
  return eventData.geo.prefectures.some((p) => targetIds.has(p.id));
}

function renderReport(report) {
  // report_classification_no===7は衛星から実際に配信される公式の訓練/試験放送
  // (月2回程度)。プッシュ通知は([訓練]プレフィックス付きで)サーバー側で
  // 別途送られるが、こちらは本物の警報と紛らわしいので画面には出さない。
  // 取消が来ないカテゴリのため、一度表示すると消せなくなる問題もある。
  if (report.report_classification_no === 7) return;

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
    const event = buildEventFromJAlert(report);
    if (isRelevantToTargetRegion(event)) addActiveEvent(event);
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
    const event = buildEventFromLAlert(report);
    if (isRelevantToTargetRegion(event)) addActiveEvent(event);
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
        if (weatherSites.delete(code) && currentPatrolCode === code) removedFocusedRegion = true;
        return;
      }
      const existing = weatherSites.get(code);
      if (!existing) newlyAddedCodes.push(code);
      const subCategory = subCats[i];
      const mergedSubCategories = existing
        ? [...new Set([...existing.subCategories, subCategory].filter(Boolean))]
        : [subCategory].filter(Boolean);
      const rawName = names[i] || (existing && existing.rawName) || String(code);
      const feature = weatherFeaturesByCode.get(code);
      weatherSites.set(code, {
        code,
        name: regionDisplayName(code, rawName),
        subCategories: mergedSubCategories,
        description: report.description || (existing && existing.description) || '',
        bounds: feature ? geometryBounds(feature.geometry) : (existing && existing.bounds) || null,
        isTestData: !!report.is_test_data,
        satelliteId: report.satellite_id,
        satellitePrn: report.satellite_prn,
        updatedAt: Date.now(),
      });
    });
    updateWeatherDisplay();
    syncActiveEventLayers();
    renderEventsPanel();
    // 新しい地域が増えた場合: 巡回が休止中ならすぐ起動し、既に巡回中なら
    // 順番を待たずその新しい地域へ割り込んでズームする(複数箇所が
    // 同時にアクティブでも、新しく発表された方を優先して見せるため)
    if (newlyAddedCodes.length) {
      if (currentPatrolCode === null) {
        kickPatrolIfIdle();
      } else {
        interruptPatrolForNewRegion(newlyAddedCodes[0]);
      }
    }
    // 巡回中に表示していた地域が解除された場合は、すぐ次の地域へ進める
    if (removedFocusedRegion) schedulePatrolNext(0);
    return;
  }

  // 台風(12)は表示しない(暴風域を正確に描く手がかりが無く、取消信号も
  // 来ないため、表示し続けると誤解を招く懸念がある)

  // 南海トラフ地震(4)・火山(8)・降灰(9)・洪水(11): カテゴリごとに1枚
  if ([4, 8, 9, 11].includes(report.disaster_category_no)) {
    if (report.information_type_no === 2) {
      otherReports.delete(report.disaster_category_no);
    } else {
      otherReports.set(report.disaster_category_no, buildEventFromOtherCategory(report));
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

  const event = buildEventFromReport(report);
  if (!isRelevantToTargetRegion(event)) return;

  const match = findMatchingGroup(report, event);
  if (match) mergeIntoActiveEvent(match, event, report);
  else addActiveEvent(event);
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
    maxZoom: 13,
    maxBounds: bounds,
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

  // 段階2: 使用頻度が低い/主要な情報表示に必須ではないデータは、ここまでの
  // 「警報エリアを塗れる」状態が整った後に、バックグラウンドで読み込む。
  // await しない(=呼び出し元のinitMap完了を待たせない)ことで、地図の
  // 初回表示・操作可能になるタイミングを優先する。
  loadEpicenterLookupTable();
  loadMunicipalityLayer();

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
    const res = await fetch('./data/municipalities.geojson');
    const municipalityGeoJSON = await res.json();
    // Lアラートの市区町村コード(ex1)は「全国地方公共団体コード」(JIS X0402、
    // 先頭0埋め5桁)そのものなので、国土数値情報(N03)の行政区域データを
    // 同じコードで直接紐付けられる(名前でのあいまい一致は不要)
    for (const f of municipalityGeoJSON.features) municipalityFeaturesByCode.set(f.properties.code, f);
    if (!map.getSource('municipality-regions')) {
      map.addSource('municipality-regions', { type: 'geojson', data: municipalityGeoJSON });
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
  });
}

connectWebSocket();

// ==================================================
// PWA: Service Worker登録(ホーム画面追加・オフラインでの見た目表示用)
// ==================================================
let swRegistration = null;
if ('serviceWorker' in navigator) {
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
