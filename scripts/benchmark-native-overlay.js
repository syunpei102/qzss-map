// ローカルサーバー上の独自地図エンジンを Chrome で測る．本番には送信しない．
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const origin = process.env.BENCH_ORIGIN || 'http://127.0.0.1:18089';
const weatherCodeCount = Number(process.env.BENCH_WEATHER_CODES || 160);
const port = Number(process.env.CDP_PORT || 19222);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qzss-native-bench-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore' });

async function until(fn, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const result = await fn(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Chrome または地図の起動がタイムアウトしました');
}

async function main() {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
  const pageUrl = `${origin}/?renderer=native&web-preview=1`;
  const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${pageUrl}`, { method: 'PUT' })).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.once('open', resolve));
  let nextId = 0;
  const pending = new Map();
  socket.on('message', data => {
    const msg = JSON.parse(data);
    if (!msg.id) return;
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); msg.error ? waiter.reject(Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await until(async () => evaluate("performance.getEntriesByName('qzss:map-ready').length > 0"), 30000);
  const result = await evaluate(`(async () => {
    const canvasHash = async () => {
      const canvas = map.getCanvas();
      const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const source = map.getSource('weather-regions');
    const weatherFeaturesCount = source.data.features.length;
    const codes = source.data.features.slice(0, ${weatherCodeCount}).map(feature => feature.properties.code);
    const filter = ['in', ['get', 'code'], ['literal', codes]];
    const colors = ['match', ['get', 'code']];
    for (const code of codes) colors.push(code, '#e63946');
    colors.push('#d9822b');
    map.setFilter('weather-fill', filter);
    map.setFilter('weather-outline', filter);
    map.setPaintProperty('weather-fill', 'fill-color', colors);
    map.setPaintProperty('weather-outline', 'line-color', colors);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    map.baseDirty = false;
    for (let i = 0; i < 5; i++) map.render();
    const initialOverlayHash = await canvasHash();
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const start = performance.now();
      for (let j = 0; j < 200; j++) map.render();
      samples.push((performance.now() - start) / 200);
    }
    samples.sort((a, b) => a - b);
    const originalZoom = map.zoom;
    const animatedStart = performance.now();
    for (let i = 0; i < 120; i++) {
      map.zoom = 4 + i / 120 * 3;
      map.baseDirty = false;
      map.render();
    }
    const animatedOverlayMs = (performance.now() - animatedStart) / 120;
    map.zoom = originalZoom;
    map.baseDirty = false;
    map.render();
    const centroidSamples = [];
    const prefectures = [...prefectureFeaturesById.values()];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      for (const feature of prefectures) {
        geometryCentroid(feature.geometry);
        mainLandBounds(feature.geometry);
      }
      centroidSamples.push(performance.now() - start);
    }
    centroidSamples.sort((a, b) => a - b);
    const report = {
      type: 'QzssDcReportJmaEarthquakeEarlyWarning', disaster_category_no: 1,
      information_type_no: 0, seismic_epicenter: '関東地方', seismic_epicenter_raw: 123,
      occurrence_time_of_earthquake: '2026-11-09T00:00:00',
      report_time: '2026-11-09T00:01:00', magnitude: '7.0',
      eew_forecast_regions_raw: [59, 58, 64, 65],
      eew_forecast_regions: ['関東', '東北', '東海', '近畿'],
      seismic_intensity_lower_limit: '震度5強', seismic_intensity_upper_limit: '震度6強',
      satellite_id: 58, satellite_prn: 186, is_test_data: true,
    };
    const weather = {
      type: 'QzssDcReportJmaWeather', disaster_category_no: 10,
      information_type_no: 0, report_classification_no: 2,
      weather_forecast_regions_raw: codes,
      weather_forecast_regions: codes.map(String),
      weather_related_disaster_sub_categories: codes.map(() => '大雨警報'),
      report_time: '2026-11-09T00:01:00', satellite_id: 58, satellite_prn: 186,
      is_test_data: true,
    };
    const weatherSamples = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      renderReport(weather);
      weatherSamples.push(performance.now() - start);
    }
    weatherSamples.sort((a, b) => a - b);
    map.render();
    const weatherOverlayHash = await canvasHash();
    const reportSamples = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      renderReport(report);
      reportSamples.push(performance.now() - start);
    }
    reportSamples.sort((a, b) => a - b);
    const baseByZoom = {};
    for (const zoom of [4, 5, 6, 7]) {
      map.zoom = zoom;
      const times = [];
      for (let i = 0; i < 12; i++) {
        map.baseDirty = true;
        const start = performance.now();
        map.render();
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      baseByZoom[zoom] = times[6];
    }
    map.zoom = 4;
    map.center = [140, 42];
    const reducedFilter = ['in', ['get', 'code'], ['literal', codes.slice(0, 5)]];
    map.setFilter('weather-fill', reducedFilter);
    map.setFilter('weather-outline', reducedFilter);
    map.setPaintProperty('weather-fill', 'fill-color', '#00ff00');
    map.setPaintProperty('weather-outline', 'line-color', '#00ff00');
    map.render();
    const changedPaintHash = await canvasHash();
    source.setData({ type: 'FeatureCollection', features: source.data.features.slice(5, 10) });
    map.render();
    const changedSourceHash = await canvasHash();
    return { engine: 'native', weatherCodes: codes.length, features: weatherFeaturesCount,
      mapReadyMs: performance.getEntriesByName('qzss:map-ready')[0].startTime,
      overlayMedianMs: samples[4], overlayP95Ms: samples[7], animatedOverlayMs,
      geometryMedianMs: centroidSamples[15], reportMedianMs: reportSamples[10], reportP95Ms: reportSamples[19],
      weatherMedianMs: weatherSamples[5], weatherMaxMs: weatherSamples[9], baseByZoom,
      initialOverlayHash, weatherOverlayHash, changedPaintHash, changedSourceHash };
  })()`);
  console.log(JSON.stringify(result));
  socket.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await new Promise(resolve => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return resolve();
    chrome.once('exit', resolve);
    chrome.kill();
  });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
