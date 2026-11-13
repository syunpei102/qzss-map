# Oracle運用・並行移行

- 本番地図のURLは維持する．GCPは並行受信を続け，通知購読APIだけをOracleへ中継する．`NOTIFICATION_BACKEND_URL`があるGCPでは自動プッシュを送らない．Oracleに同じVAPID鍵・購読登録・有効情報を移してから切り替える．
- 比較期間はGCPへ常時WebSocket接続するため，Cloud Runの稼働費用削減は保証しない．移行完了時に比較接続を止める．
- 実電文・動画・秘密情報はGitへ入れない．コード・テンプレート・匿名テストのみGit管理．電文JSONLはVM内30日，投稿済み動画は7日，未投稿動画は削除しない．録画一覧30日．
- 比較の時刻差は監視VMへの到着差であり，異なる端末時計を引いたネットワーク遅延ではない．再接続時の過去情報は除外する．片側のみの電文は2分待って不一致とする．
- 再生は認証サイトで本番と同じpublicの地図をsandboxモードで使用する．WebSocket・書込み・通知・SW登録を遮断．表示期限は画面検証用60秒．10分・20分はオフラインモデルで仮想時間を進めて検査する．
- 日次モデル検査，ブラウザ起動・保存電文1件の煙検査を1並列で行う．これは全画角条件の網羅テストではない．画面PNGと結果JSONをVMへ保存する．
- バックアップはOpenSSL CMSで暗号化．復号用秘密鍵と証明書はMacで保管し，VMには公開証明書だけ配置する．GCSの専用バケットへ暗号化済みファイルだけを保存し30日で削除．アップロード専用SAを使用する．動画本体はバックアップ対象外．

## 復元

Macの復号鍵を失わないように別の安全な場所へ保管する．

```sh
openssl cms -decrypt -binary -inform DER -in state.cms -recip qzss-backup.crt -inkey qzss-backup.key -out state.tar.gz
mkdir recovered
# 復号内容はまず別ディレクトリで確認し，本番へ直接上書きしない．
tar -xzf state.tar.gz -C recovered
```

環境変数ファイルは600，格納ディレクトリは700とする．サービスの認証情報や復号鍵をログへ出力しない．


## 現在の役割分担

`eq.shum10.com`の地図・WebSocketはGCPを維持する（ユーザー指定）．通知購読APIはOracleへ中継し，自動プッシュはOracleだけで送る．Discordの既存設定コマンドはGCPに残し，Oracleは公開/configを60秒ごとに同期する．YouTubeと録画トリガーはOracleを使用する．`replay.shum10.com`は別の認証付きサイト．

日次検査は03:00，暗号化バックアップは04:00（いずれも日本時間，ランダムな遅延あり）．受信比較は5分ごと，録画検査・保持期限の整理は1時間ごと．GCP比較接続を維持する間はCloud Runの稼働課金が継続する．

## 再構築の要点

Gitの対象コミットを取得し，サーバーはルートDockerfile，検証用はops/Dockerfileでビルドする．暗号化バックアップから復元した環境ファイル・保存状態をマウントし，8080/8090はloopbackだけに公開する．Caddyで各HTTPSホストへ転送する．実設定ファイルはGitへ登録しない．

復号鍵はMacのDownloads/qzss-private-backupに保管する．動画・受信電文はVM内のみのため，VMのディスクを失った場合は復旧できない．バックアップ用サービスアカウントは専用GCSバケットへのobjectCreatorだけを持つ．
