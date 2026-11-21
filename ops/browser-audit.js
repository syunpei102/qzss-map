'use strict';

const { chromium } = require('playwright-core');
const fs = require('node:fs');

const root = process.env.OPS_DATA || '/ops-data';
const auditDir = root + '/audits';
const started = Date.now();
const timings = {};
let stage = 'browser launch';

async function measure(name, action) {
  stage = name;
  const begin = Date.now();
  try {
    return await action();
  } finally {
    timings[name] = Date.now() - begin;
  }
}

async function audit() {
  fs.mkdirSync(auditDir, { recursive: true });
  const browser = await measure('browser launch', () => chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    timeout: 120000,
  }));

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      timezoneId: 'Asia/Tokyo',
      httpCredentials: {
        username: process.env.OPS_USER || 'qzss',
        password: process.env.OPS_PASSWORD,
        origin: 'http://127.0.0.1:8090',
      },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await measure('replay page DOM', () => page.goto('http://127.0.0.1:8090/', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    }));
    await measure('map frame visible', () => page.frameLocator('#map').locator('#now_time').waitFor({ timeout: 120000 }));

    const frame = page.frames().find((item) => item.url().includes('/index.html?sandbox=1'));
    if (!frame) throw new Error('Sandbox map frame was not loaded');
    await measure('map ready', async () => {
      await frame.waitForFunction(
        () => typeof mapReady !== 'undefined' && typeof isInitialLoad !== 'undefined',
        undefined,
        { timeout: 120000 },
      );
      await frame.evaluate(() => mapReady);
    });

    const files = await measure('saved reports API', async () => {
      const response = await page.request.get('http://127.0.0.1:8090/api/files', { timeout: 30000 });
      if (!response.ok()) throw new Error(`Saved reports API returned ${response.status()}`);
      return response.json();
    });
    let replayed = 0;
    if (files.length) {
      await measure('saved report replay', async () => {
        await page.locator('#files').selectOption(files.at(-1));
        await page.locator('#load').click();
        await page.waitForFunction(() => !document.querySelector('#step').disabled, undefined, { timeout: 30000 });
        await page.locator('#step').click();
        await page.waitForTimeout(1500);
        replayed = 1;
      });
    }

    const cases = await measure('state replay cases', async () => {
      await frame.addScriptTag({ url: 'http://127.0.0.1:8090/state-replay-cases.js' });
      return frame.evaluate(async () => {
        const passed = [];
        for (const testCase of QzssStateReplayCases.cases) {
          clearAllActiveEvents();
          isInitialLoad = false;
          for (const step of testCase.steps) {
            const result = renderReport({ ...step.report, is_test_data: true });
            if (result.status === 'error') throw new Error(`${testCase.id} render failed`);
          }
          if (testCase.id === 'case6' && quakeLockRecords().filter((event) => event.disasterCategoryNo === 3).length !== 2) {
            throw new Error('Both intensities must remain visible with tsunami');
          }
          passed.push(testCase.id);
        }
        return passed;
      });
    });
    if (!cases.length) throw new Error('No state replay cases were executed');
    await measure('screenshot', () => page.screenshot({ path: auditDir + '/browser-latest.png', timeout: 30000 }));
    if (errors.length) throw new Error(errors.join('; '));

    fs.writeFileSync(auditDir + '/browser-latest.json', JSON.stringify({
      at: Date.now(),
      passed: true,
      durationMs: Date.now() - started,
      timings,
      replayed,
      cases,
      scope: 'native地図の起動と保存電文1件の画面確認．全描画条件の網羅検査ではありません．',
    }));
  } finally {
    await browser.close();
  }
}

audit().catch((error) => {
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(auditDir + '/browser-latest.json', JSON.stringify({
    at: Date.now(),
    passed: false,
    stage,
    durationMs: Date.now() - started,
    timings,
    error: error.message,
  }));
  process.exitCode = 1;
});
