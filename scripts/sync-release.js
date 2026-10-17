// 公開履歴を正本に，VERSIONと紹介ページを同期する．--checkはCI用．
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const releases = JSON.parse(fs.readFileSync(path.join(root, 'public/releases.json'), 'utf8'));
if (!releases.length || !/^\d+\.\d+\.\d+$/.test(releases[0].version)) throw new Error('最新バージョンはmajor.minor.patch形式にしてください');
const seen = new Set();
for (const r of releases) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(r.version) || seen.has(r.version)
      || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Array.isArray(r.changes)
      || !r.changes.length || r.changes.some(c => typeof c !== 'string')) throw new Error('不正なリリース情報');
  seen.add(r.version);
}
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const displayDate = s => {
  const [year, month, day] = s.split('-').map(Number);
  const weekday = '日月火水木金土'[new Date(`${s}T12:00:00+09:00`).getUTCDay()];
  return `${year}年${month}月${day}日（${weekday}）`;
};
const start = '<!-- RELEASE_HISTORY_START -->';
const end = '<!-- RELEASE_HISTORY_END -->';
const section = `${start}
<section class="band" id="updates" aria-labelledby="updates-title">
  <div class="wrap">
    <span class="eyebrow">アップデート履歴</span>
    <h2 id="updates-title">現在のバージョン ${escape(releases[0].version)}</h2>
    <p class="sub">変更内容を新しい順に掲載しています．旧バージョンの日付はコードの更新日です．</p>
    ${releases.map(r => `<article class="release-entry">
      <h3>v${escape(r.version)} <time datetime="${escape(r.date)}">${escape(displayDate(r.date))}</time></h3>
      <ul>${r.changes.map(c => `<li>${escape(c)}</li>`).join('')}</ul>${r.note ? `\n      <p class="sub">${escape(r.note)}</p>` : ''}
    </article>`).join('\n    ')}
  </div>
</section>
${end}`;
const infoPath = path.join(root, 'public/info.html');
const html = fs.readFileSync(infoPath, 'utf8');
if (!html.includes(start) || !html.includes(end)) throw new Error('紹介ページに履歴マーカーがありません');
const updated = html.slice(0, html.indexOf(start)) + section + html.slice(html.indexOf(end) + end.length);
for (const [file, content] of [[path.join(root, 'VERSION'), releases[0].version + '\n'], [infoPath, updated]]) {
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error(`${path.basename(file)}が履歴と不一致です．npm run release:syncを実行してください`);
  } else fs.writeFileSync(file, content);
}
