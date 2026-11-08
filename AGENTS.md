# リリース管理

- 公開更新時は`RELEASING.md`に従い，バージョン番号と「このマップについて」の履歴を必ず同期する．
- 正本は`public/releases.json`．`npm run release:sync`で生成し，`npm run release:check`で確認する．
- 同じバージョンで別の修正を配信しない．Cloud Run反映と受信機OTA適用の確認状態を区別し，Obsidianへ記録する．
