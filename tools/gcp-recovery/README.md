# GCP保存データの復旧

> 2026年11月23日（月）にユーザーの指示でMac上のバックアップ本体を削除した．以下は保存時の手順記録であり，現状では復旧コマンドを実行できない．

バックアップ本体はMacの `~/Downloads/qzss-gcp-recovery/` に保管する．画像・ソース本体と認証を含む設定はGitへ追加しない．このディレクトリにはOCI形式のコンテナ，元タグ・ダイジェストの対応表，GCSソースの世代・チェックサム・復元用設定を含む．

## 検証

```sh
python3 tools/gcp-recovery/recover.py "$HOME/Downloads/qzss-gcp-recovery"
```

全blobのSHA-256，manifestの参照先とサイズ，ソース全件のSHA-256とサイズを検証する．既定ではクラウドへ書き込まない．

## イメージの復元

Macでは `brew install skopeo` でOCI読込み・転送コマンドを用意する．gcloudで対象プロジェクトへログインし，必要なリポジトリが存在することを確認する．`image-map.json` で元のイメージ名と `localRef` を選ぶ．

```sh
python3 tools/gcp-recovery/recover.py "$HOME/Downloads/qzss-gcp-recovery" --restore-image image-0000
```

元のダイジェストを保ち，`restored-<元ダイジェスト先頭12文字>` タグで元のリポジトリへ戻す．必要なら `--destination REGISTRY/PROJECT/REPO/IMAGE:TAG` を指定できる．認証トークンは引数やGitに残さず，一時認証ファイルは処理後に削除する．元タグ一覧は対応表に保存してある．サービス再配備は自動では行わない．元設定はバックアップの `service-configs/` を参照する．

## ソースの復元

`sources/inventory.json` からバケット名・オブジェクト名・世代を選ぶ．

```sh
python3 tools/gcp-recovery/recover.py "$HOME/Downloads/qzss-gcp-recovery" --restore-source BUCKET OBJECT --generation GENERATION
```

同名の現行オブジェクトがある場合は上書きしない．IAM・バケット設定は別途必要．本番を復元する場合，Oracleとの二重通知や二重受信が発生しないよう，トラフィックを切り替える前に送信先と通知設定を確認する．

## 退避・整理の記録

2026年11月15日（日）に，243件のイメージ版と45世代のビルド用ソースを退避した．全チェックサムと1,725個の参照blobを検証し，旧イメージのOCI読出し・再コピーで元ダイジェストを維持できることを確認した．旧イメージ241件とソース42世代をGCPから削除し，現用テストサイトと料金保護のイメージ各1件，参照中のソース3世代を残した．テストページはHTTP 200，料金保護のFunctionはACTIVEを確認した．

退避フォルダーの `verification-summary.json`，`cleanup-results.json`，`CHECKSUMS.sha256` に対象と検証結果を保存する．ソースの削除後もGCSの7日間のsoft delete保護は維持するため，その期間は保存料金が残る．日次暗号化バックアップと旧状態バケットは整理対象に含めない．Oracle・Cloud Runの公開版や受信機OTAは変更していない．このGit内のツールだけでは復元できないため，Mac側のバックアップ本体も保持する．
