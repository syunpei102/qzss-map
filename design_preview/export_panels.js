const { chromium } = require('/Users/syunpei/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const path = require('path');

const names = [
  '01_台風_Before',
  '02_台風_After',
  '03_気象警報_Before',
  '04_気象警報_After',
  '05_緊急地震速報+大津波警報_統合',
  '06_緊急地震速報_単体',
  '07_震度速報_単体',
  '08_震源_単体',
  '09_テストデータ_台風',
  '10_取消_台風',
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.goto('http://localhost:8199/preview.html');
  await page.waitForTimeout(500);

  const frames = await page.$$('.panel-frame');
  console.log('found', frames.length, 'panel-frame elements');
  for (let i = 0; i < frames.length; i++) {
    const name = names[i] || `panel_${i + 1}`;
    const outPath = path.join(__dirname, `${name}.png`);
    await frames[i].screenshot({ path: outPath });
    console.log('saved', outPath);
  }

  await browser.close();
})();
