#!/usr/bin/env node
// QZSS関連リポジトリのmdファイルを1つのHTMLにまとめて生成するスクリプト。
//
// 使い方:
//   node ~/Desktop/map/build_docs_index.js
//
// 対象のmdファイルのどれかを編集したら、このスクリプトを再実行して
// QZSS_docs_index.html を作り直すこと(自動監視はしていない)。
//
// Desktop整理により、このスクリプト自体もmap/直下にある(qzss_pi_package
// はさらにその中のサブフォルダー)。パスは全てこのスクリプトの場所
// (__dirname、つまりmap/)からの相対で組み立てる
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MAP_DIR = __dirname;

// repo: 見出し・ナビ表示用の名前。dir: 実際にファイルを探すMAP_DIRからの
// 相対フォルダー("."ならmap/直下そのもの)
const DOCS = [
  { repo: "map", dir: ".", file: "README.md", label: "qzss-map セットアップ・機能全般" },
  { repo: "map", dir: ".", file: "PERFORMANCE_REPORT.md", label: "性能改善・品質検証レポート" },
  { repo: "map", dir: ".", file: "QA_TEST_REPORT.md", label: "QAテストレポート(セキュリティ・回帰・性能)" },
  { repo: "qzss_pi_package", dir: "qzss_pi_package", file: "SETUP.md", label: "ラズパイ初期セットアップ全般" },
  { repo: "qzss_pi_package", dir: "qzss_pi_package", file: "NEW_DEVICE_ONBOARDING.md", label: "新しいラズパイが届いた時の登録手順" },
  { repo: "qzss_pi_package", dir: "qzss_pi_package", file: "DISCORD_SETUP.md", label: "Discord通知・Bot(操作コマンド)の設定" },
  { repo: "qzss_pi_package", dir: "qzss_pi_package", file: "DEVICE_VERIFICATION.md", label: "デバイス管理 実機動作確認チェックリスト" },
];

function slug(repo, file) {
  return `${repo}-${file}`.replace(/[^a-zA-Z0-9]+/g, "-");
}

function mdToHtml(absPath) {
  return execFileSync("npx", ["--yes", "marked", absPath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function formatDate(d) {
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

const sections = [];
const navItems = [];
const missing = [];

for (const doc of DOCS) {
  const absPath = path.join(MAP_DIR, doc.dir, doc.file);
  const id = slug(doc.repo, doc.file);
  if (!fs.existsSync(absPath)) {
    missing.push(`${doc.repo}/${doc.file}`);
    continue;
  }
  const stat = fs.statSync(absPath);
  const html = mdToHtml(absPath);
  navItems.push(
    `<li><a href="#${id}">${doc.repo}/${doc.file}</a><span class="nav-label">${doc.label}</span></li>`
  );
  sections.push(`
<section id="${id}">
  <div class="doc-header">
    <h2>${doc.repo}/${doc.file}</h2>
    <div class="doc-meta">${doc.label} ・ 最終更新: ${formatDate(stat.mtime)}</div>
  </div>
  <div class="doc-body">
${html}
  </div>
</section>`);
}

if (missing.length) {
  console.warn("⚠️ 見つからなかったファイル(スキップ):", missing.join(", "));
}

const generatedAt = formatDate(new Date());

const page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QZSSプロジェクト ドキュメント一覧</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
    display: flex;
    min-height: 100vh;
    background: #f7f7f8;
    color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e6e6; }
  }
  nav {
    width: 300px;
    flex-shrink: 0;
    padding: 24px 16px;
    border-right: 1px solid rgba(128,128,128,0.25);
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }
  nav h1 { font-size: 15px; margin: 0 0 4px; }
  nav .generated-at { font-size: 11px; opacity: 0.6; margin-bottom: 16px; }
  nav ul { list-style: none; padding: 0; margin: 0; }
  nav li { margin-bottom: 2px; }
  nav a {
    display: block;
    padding: 8px 10px;
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
  }
  nav a:hover { background: rgba(128,128,128,0.15); }
  nav .nav-label {
    display: block;
    font-size: 11px;
    font-weight: 400;
    opacity: 0.65;
    padding: 0 10px 6px;
  }
  main { flex: 1; min-width: 0; padding: 32px 40px 120px; max-width: 900px; }
  section { margin-bottom: 64px; scroll-margin-top: 16px; }
  section:not(:first-child) { padding-top: 40px; border-top: 1px solid rgba(128,128,128,0.25); }
  .doc-header h2 {
    font-size: 20px;
    margin: 0 0 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .doc-meta { font-size: 12px; opacity: 0.6; margin-bottom: 24px; }
  .doc-body :is(h1, h2, h3, h4) { margin-top: 1.6em; }
  .doc-body h1 { font-size: 18px; }
  .doc-body h2 { font-size: 16px; }
  .doc-body h3 { font-size: 14.5px; }
  .doc-body { font-size: 14.5px; line-height: 1.7; }
  .doc-body pre {
    background: rgba(128,128,128,0.12);
    padding: 12px 14px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 13px;
  }
  .doc-body code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(128,128,128,0.14);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.9em;
  }
  .doc-body pre code { background: none; padding: 0; }
  .doc-body table { border-collapse: collapse; width: 100%; font-size: 13.5px; margin: 1em 0; }
  .doc-body th, .doc-body td { border: 1px solid rgba(128,128,128,0.3); padding: 6px 10px; text-align: left; }
  .doc-body th { background: rgba(128,128,128,0.12); }
  .doc-body blockquote {
    border-left: 3px solid rgba(128,128,128,0.4);
    margin: 1em 0;
    padding: 0.2em 1em;
    opacity: 0.85;
  }
  .doc-body a { color: #2f6fed; }
  @media (max-width: 800px) {
    body { flex-direction: column; }
    nav { width: auto; height: auto; position: static; border-right: none; border-bottom: 1px solid rgba(128,128,128,0.25); }
    main { padding: 24px 20px 80px; }
  }
</style>
</head>
<body>
<nav>
  <h1>QZSSプロジェクト ドキュメント一覧</h1>
  <div class="generated-at">生成日時: ${generatedAt}<br>mdファイルを更新したら build_docs_index.js を再実行してください</div>
  <ul>
${navItems.join("\n")}
  </ul>
</nav>
<main>
${sections.join("\n")}
</main>
</body>
</html>
`;

fs.writeFileSync(path.join(MAP_DIR, "QZSS_docs_index.html"), page);
console.log(`✅ QZSS_docs_index.html を生成しました(${DOCS.length - missing.length}件のドキュメント)`);
