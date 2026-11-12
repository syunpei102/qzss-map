(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const frame = $('test-map');
  const token = crypto.randomUUID();
  const pending = new Map();
  let ready = false, generation = 0, timer = null, serial = 0;
  const buttons = [];
  function command(value) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('地図から応答がありません．ページを再読み込みしてください．')); }, 15000);
      pending.set(id, { resolve, reject, timeout });
      frame.contentWindow.postMessage({ ...value, type: 'qzss-test-command', id, token }, location.origin);
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.token !== token) return;
    if (event.data.type === 'qzss-test-ready') {
      ready = true;
      buttons.forEach(button => { button.disabled = false; });
      $('ready-status').textContent = '';
    }
    if (event.data.type === 'qzss-test-error') $('ready-status').textContent = event.data.error;
    const entry = pending.get(event.data.id);
    if (event.data.type === 'qzss-test-result' && entry) {
      clearTimeout(entry.timeout); pending.delete(event.data.id);
      if (event.data.error) entry.reject(new Error(event.data.error)); else entry.resolve(event.data.results);
    }
  });
  function stopTimer() { generation++; clearTimeout(timer); timer = null; }
  function fail(error) {
    stopTimer(); $('menu').hidden = false; $('playback').hidden = true;
    $('ready-status').textContent = error.message;
  }
  async function chooseAgain() {
    stopTimer();
    $('menu').hidden = false; $('playback').hidden = true;
    if (ready) await command({ reset: true });
  }
  async function play(test) {
    if (!ready) return;
    stopTimer();
    const run = generation;
    buttons.forEach(button => { button.disabled = true; });
    try {
      await command({ reset: true });
      if (run !== generation) return;
      $('menu').hidden = true; $('playback').hidden = false;
      $('cancel').textContent = '中止・選び直す';
      const issued = new Date().toISOString();
      let index = 0, due = performance.now() + 3000;
      const tick = async () => {
        if (run !== generation) return;
        const seconds = Math.max(0, Math.ceil((due - performance.now()) / 1000));
        $('progress').textContent = `${index + 1}/${test.steps.length}　${test.steps[index].name}まで ${seconds}秒`;
        if (seconds > 0) { timer = setTimeout(() => tick().catch(fail), 200); return; }
        const report = { ...test.steps[index].report, report_time: issued, occurrence_time_of_earthquake: issued,
          raw: `browser-test:${test.id}:${index}:${issued}` };
        const results = await command({ reports: [report] });
        if (run !== generation) return;
        if (!results.length || results[0].status === 'skipped') throw new Error(`表示できませんでした：${results[0]?.reason || 'unknown'}`);
        index++;
        if (index < test.steps.length) {
          due = performance.now() + 10000;
          timer = setTimeout(() => tick().catch(fail), 200);
        } else {
          $('progress').textContent = `${test.name}を疑似受信しました．`;
          $('cancel').textContent = 'テストを選び直す';
        }
      };
      await tick();
    } catch (error) {
      fail(error);
    } finally { buttons.forEach(button => { button.disabled = !ready; }); }
  }
  for (const test of window.QzssTestCases) {
    const button = document.createElement('button');
    button.type = 'button'; button.disabled = true; button.dataset.case = test.id;
    for (const [className, value] of [['case-name', test.name], ['case-detail', test.detail], ['case-action', '開始']]) {
      const text = document.createElement('span'); text.className = className; text.textContent = value; button.append(text);
    }
    button.addEventListener('click', () => play(test));
    buttons.push(button); $('cases').append(button);
  }
  $('cancel').addEventListener('click', () => chooseAgain().catch(error => { $('ready-status').textContent = error.message; }));
  frame.src = `./index.html?sandbox=1&renderer=native&web-preview=1#${token}`;
})();
