// ブラウザ・配備設定の静的な回帰確認(ブラウザ実行なしで検証できる範囲)．
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('initial map stage waits only for the three essential datasets (Issue #20)', () => {
  const main = read('public/main.js');
  const stage1 = main.slice(main.indexOf('const [tsunamiGeoJSON, prefectureGeoJSON, weatherRegionsGeoJSON]'), main.indexOf("markInitialLoad('stage1-data')"));
  assert.ok(stage1.includes('prefectures.geojson') && stage1.includes('tsunami_regions.geojson') && stage1.includes('weather_regions.geojson'));
  for (const late of ['flood_rivers', 'volcanoes', 'region-groups']) assert.ok(!stage1.includes(late), `${late} must not block stage 1`);
  for (const fn of ['loadFloodRivers', 'loadVolcanoes', 'loadRegionGroups']) {
    const body = main.slice(main.indexOf(`async function ${fn}`));
    assert.match(body.slice(0, 900), /try \{[\s\S]*catch \(err\)/, `${fn} isolates its own failure`);
  }
  assert.match(main, /replayDeferredGeoReports\('flood:'\)/);
  assert.match(main, /replayDeferredGeoReports\('volcano:'\)/);
});

test('lightweight idle view is a setting, never a constant false (Issue #21)', () => {
  const main = read('public/main.js');
  assert.doesNotMatch(main, /function shouldUseLightweightIdleView\(\) \{\s*return false;\s*\}/);
  assert.match(main, /LIGHTWEIGHT_IDLE_ENABLED = readLightweightIdleSetting\(\)/);
  assert.match(main, /return localStorage\.getItem\('qzss\.lightweightIdle'\) === '1'/, 'default stays off');
});

test('shared browser modules are loaded, cached offline, and copied into the image', () => {
  const html = read('public/index.html');
  const sw = read('public/sw.js');
  const shared = ['report-ttl.js', 'earthquake-identity.js'];
  for (const f of shared) {
    assert.ok(html.indexOf(`src="${f}"`) !== -1 && html.indexOf(`src="${f}"`) < html.indexOf('src="main.js"'), `${f} before main.js`);
    assert.ok(sw.includes(`./${f}`), `${f} precached`);
  }
  assert.ok(sw.includes("importScripts('./push-display.js')") && sw.includes('./push-display.js'));
  assert.doesNotMatch(sw, /qzss-alert/, 'no fixed notification tag');
  const docker = read('Dockerfile');
  for (const f of ['server.js', 'report-state.js', 'persist-queue.js', 'request-guards.js', 'device-commands.js']) assert.ok(docker.includes(f), `Dockerfile copies ${f}`);
  // server.jsがrequireするローカルモジュールは全てイメージに入る
  for (const m of read('server.js').matchAll(/require\("\.\/([\w-]+)(\.js)?"\)/g)) {
    if (m[1] === 'public') continue;
    assert.ok(docker.includes(`${m[1]}.js`), `Dockerfile copies ${m[1]}.js`);
  }
});

test('Cloud Run is pinned to one instance because state is in process memory (Issue #13)', () => {
  const deploy = read('deploy_gcloud.sh');
  assert.match(deploy, /MAX_INSTANCES=1/);
  assert.match(deploy, /--max-instances "\$MAX_INSTANCES"/);
  assert.match(read('README.md'), /最大1インスタンス/);
});

test('every start script delegates to the single official receiver (Issue #19)', () => {
  for (const f of ['start_pi.sh', 'start_receiver.sh', 'start_prod.sh']) {
    const src = read(f);
    assert.match(src, /receiver_launcher\.sh/, f);
    assert.doesNotMatch(src, /read_legacy\.py/, `${f} must not launch the legacy receiver directly`);
  }
});
