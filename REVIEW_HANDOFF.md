# コードレビュー引き継ぎ資料

更新日：2026-09-21

## 現在地

`qzss-map`と，入れ子の別リポジトリ`qzss_pi_package`をレビューし，GitHub Issueへの登録，Claude Code Sonnetによる修正，独立再レビュー，回帰テスト追加，PR作成まで完了した．デプロイは行っていない．IssueはPRのレビュー，CI，実機確認，マージ後に完了判定できるようopenのままである．

- 地図側PR：<https://github.com/syunpei102/qzss-map/pull/24>
- Pi側PR：<https://github.com/syunpei102/qzss-pi-package/pull/20>
- GitHub Actions：両PRとも成功，merge stateは`CLEAN`．

## GitHub Issue

- `qzss-map`：#1〜#23を登録した．#2は仕様の誤認，#9は#3との重複としてclose済み．有効なopen Issueは21件．
- `qzss-pi-package`：#1〜#19を登録した．19件すべてopen．
- 合計42件を登録し，うち有効な問題は40件，誤認／重複は2件．
- 一覧：<https://github.com/syunpei102/qzss-map/issues>，<https://github.com/syunpei102/qzss-pi-package/issues>

## 最終テスト結果

- `qzss-map` Node：52件成功，失敗0件．loopback実ソケットの統合テストを含む．
- `qzss-map` Python：13件成功，失敗0件．
- `qzss-pi-package` Python：114件成功，失敗0件．
- Pi補助テスト：`test_is_in_scope.py`と`test_reception_watch.py`が全成功．
- 全シェルスクリプトの`bash -n`，主要Pythonの`py_compile`，両リポジトリの`git diff --check`が成功．
- `npm audit --omit=dev`：既知脆弱性0件．

## 残る実機確認

自動テストで確認できない次の項目は，`qzss_pi_package/DEVICE_VERIFICATION.md`に安全な確認手順を用意した．

- Raspberry Pi 3B+で`ondemand` governorが利用可能であり，温度／負荷が妥当であること．
- 8080番がloopbackだけで待ち受け，別LAN端末から到達不能であること．
- 受信断watchdogのUSBリセット／デコーダー再起動が実機で復旧につながること．
- root所有のsystemd unit helperとsudoersを既存端末へ導入できること．
- 状態報告停止から15分でオフライン表示され，報告再開で復帰すること．
- Pi軽量描画設定の採用可否は，画面品質と実測CPUを比較して決めること．

## 再開時のコマンド

```bash
cd /Users/syunpei/Desktop/map
git status --short
npm test
./venv/bin/python -m unittest discover -s test -p 'test_*.py' -v
npm audit --omit=dev
git diff --check

cd /Users/syunpei/Desktop/map/qzss_pi_package
git status --short
./venv/bin/python -m unittest discover -s . -p 'test_*.py' -v
./venv/bin/python test_is_in_scope.py
./venv/bin/python test_reception_watch.py
bash -n ./*.sh
git diff --check
```

`npm test`の`LOCAL_STATE_ONLY defaults to loopback-only binding`は実ソケットを開く．sandboxで`EPERM`になる場合は，loopback待受が許可された環境で実行する．今回は許可環境で成功済みである．

## 作業ツリーの注意

- ルート`.gitignore`は作業開始前から存在したユーザー変更であり，今回の作業で取り消していない．
- `qzss_pi_package`は独立したGitリポジトリである．ルートリポジトリと別々に差分確認／コミットすること．
- Claude用の一時worktreeは同期確認後に削除済みである．
- 自動ロールバック確認は稼働checkoutを壊さず，一時cloneとコマンドスタブで行う手順へ変更済みである．
- 両リポジトリのコミット／push／PR作成とCI成功確認は実施済みである．デプロイは未実施．次担当者はPRレビューと実機確認後にマージ／デプロイし，対応Issueをcloseすること．
