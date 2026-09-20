# QZSS地図システム コードレビュー完了報告

実施日：2026-09-21

## 結論

地図サーバー／ブラウザ／受信デコーダー／Raspberry Pi運用スクリプトを再レビューし，発見した問題をすべてGitHub Issueへ登録した．GitHubには合計42件を登録し，仕様誤認1件と完全重複1件をcloseしたため，有効な問題は40件である．Claude Codeは指定どおりSonnetを使用して修正し，その後に差分を独立再レビューした．

最終結果は，地図側の自動テスト65件とPi側114件がすべて成功，`npm audit --omit=dev`は脆弱性0件である．修正は[地図側PR #24](https://github.com/syunpei102/qzss-map/pull/24)と[Pi側PR #20](https://github.com/syunpei102/qzss-pi-package/pull/20)へpush済みで，両PRのGitHub Actionsも成功した．デプロイは行っていない．実機固有の6項目も未確認なので，Issueはopenのまま維持した．

## Issue登録結果

| 対象 | 登録 | 有効なopen | close | 一覧 |
|---|---:|---:|---:|---|
| qzss-map | 23件 | 21件 | 2件 | [GitHub Issues](https://github.com/syunpei102/qzss-map/issues) |
| qzss-pi-package | 19件 | 19件 | 0件 | [GitHub Issues](https://github.com/syunpei102/qzss-pi-package/issues) |
| 合計 | 42件 | 40件 | 2件 |  |

再レビューで追加した問題は，地図側[#23](https://github.com/syunpei102/qzss-map/issues/23)，Pi側[#17](https://github.com/syunpei102/qzss-pi-package/issues/17)，[#18](https://github.com/syunpei102/qzss-pi-package/issues/18)，[#19](https://github.com/syunpei102/qzss-pi-package/issues/19)である．内容は，オフライン判定の130分遅延，sudoers引数不一致，状態JSONの未エスケープ，実機確認資料の旧構成／破壊的手順である．

## 主な修正

### 通報の正しさ

- 気象警報の部分取消，同一震央で時刻が異なる地震，津波／洪水／降灰／J-Alertの更新と取消を，事象単位で正しく統合するようにした．
- サーバーとブラウザで共通のTTL定義を使い，早期消失と再接続時の古い通報復活を防止した．
- 不完全なLアラート楕円座標，未知PRN，大文字NMEAチェックサム，不正UBX長で受信処理が終了しないようにした．
- 送信成功後だけ重複履歴へ記録し，一時的なネットワーク障害後に即時再送できるようにした．

### セキュリティと永続化

- Piローカルサーバーを既定で`127.0.0.1`待受にし，無認証LAN公開を防止した．
- 公開POST APIへ入力検証，レート制限，件数上限を追加した．
- プッシュ購読，通報状態，レイテンシ，デバイスコマンドの保存を直列化／間引きし，古い状態による上書きを防止した．
- デバイスコマンドを永続化し，ackされるまで再配信する方式へ変更した．Pi側には電源断に耐えるinbox／ledgerを追加し，rebootの二重実行を防止した．
- 状態報告JSON全体をPython標準JSONエンコーダーで生成し，端末名の引用符，バックスラッシュ，改行による破損／注入を防止した．
- 本番依存を更新し，既知脆弱性を0件にした．

### Raspberry Pi性能／ネットワーク／運用

- 送信キューを上限付き優先度キューへ変更し，再送待機中も新しい緊急通報を先に送れるようにした．heartbeatは最新1件へ集約する．
- 設定APIの二重取得を1回へ統合した．
- CPU governorの常時`performance`を廃止し，負荷追従の`ondemand`へ変更した．
- Cloud監視を30秒から2分へ緩和し，正常時ログを抑制，ログローテーションを追加した．状態報告は1時間から5分へ短縮した．
- サーバーのオフライン判定を130分から15分へ短縮し，一時的な2回の報告欠落は許容する境界テストを追加した．
- OTA，緊急更新，手動更新，状態監視の競合を`flock`で排他し，失敗を成功扱いしないようにした．
- OTAでsystemd unitをroot所有ヘルパー経由で安全に同期し，旧unitを削除，新unitを有効化できるようにした．
- 受信断watchdogをsystemdへ登録し，外部コマンド失敗時の誤通知／誤クールダウンを修正した．
- sudoersの許可引数と実際の`systemctl`引数を完全一致させた．
- 稼働checkoutを壊す実機試験を廃止し，一時cloneとスタブを使う非破壊手順へ変更した．

## 追加した確認手段

通常の回帰確認は次のコマンドだけで再実行できる．

```bash
cd /Users/syunpei/Desktop/map
npm test
./venv/bin/python -m unittest discover -s test -p 'test_*.py' -v
npm audit --omit=dev

cd /Users/syunpei/Desktop/map/qzss_pi_package
./venv/bin/python -m unittest discover -s . -p 'test_*.py' -v
./venv/bin/python test_is_in_scope.py
./venv/bin/python test_reception_watch.py
```

実機確認は[qzss_pi_package/DEVICE_VERIFICATION.md](/Users/syunpei/Desktop/map/qzss_pi_package/DEVICE_VERIFICATION.md)にまとめた．状態報告，コマンドack，OTAロールバック，15分オフライン遷移，受信watchdog，CPU governor，loopback待受，ハードウェアwatchdogを順番に確認できる．新規端末手順も[qzss_pi_package/NEW_DEVICE_ONBOARDING.md](/Users/syunpei/Desktop/map/qzss_pi_package/NEW_DEVICE_ONBOARDING.md)で5分周期とテンプレートunit名へ更新した．

## 検証結果

| 検証 | 結果 |
|---|---|
| `qzss-map` Nodeテスト | 52/52成功 |
| `qzss-map` Pythonテスト | 13/13成功 |
| `qzss-pi-package` Pythonテスト | 114/114成功 |
| Pi地域判定／受信監視補助テスト | 全成功 |
| 全シェル`bash -n` | 成功 |
| 主要Python`py_compile` | 成功 |
| 両リポジトリ`git diff --check` | 成功 |
| `npm audit --omit=dev` | 脆弱性0件 |
| GitHub Actions | 地図側PR／Pi側PRとも成功 |

## 未確認事項と次の判断

自動テストではハードウェア，熱，実ネットワーク，systemd／sudoersの実機状態までは保証できない．次を実機で確認する必要がある．

1. Pi 3B+で`ondemand`が利用可能であり，実測CPU／温度／描画品質が妥当か．
2. 別LAN端末からPiの8080番へ接続できず，localhostのキオスクは表示できるか．
3. 受信停止時にUSBリセット／デコーダー再起動で復旧するか．
4. 既存端末で`install_services.sh`を再実行し，unit helperとsudoersを導入できるか．
5. 報告停止15分後にオフラインとなり，再開後にオンラインへ戻るか．
6. 軽量描画設定を有効にすべきか．これは画面品質と実測性能を比較して決める．

## 引き渡し状態

- 完了報告：このファイル．
- 再開用資料：[REVIEW_HANDOFF.md](/Users/syunpei/Desktop/map/REVIEW_HANDOFF.md)．
- コミット／push／PR：実施済み．地図側#24，Pi側#20．両方のGitHub Actions成功を確認済み．
- デプロイ：未実施．PRのCIと実機確認後に別工程で行う．
- Issue：PRのレビュー，CI，実機確認，マージが完了したIssueからcloseする．
- 既存のルート`.gitignore`変更はユーザー所有として保持した．
