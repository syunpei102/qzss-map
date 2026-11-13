# QZSS配信と通報前後の録画

対象はOracle E2.1.Micro上のUbuntuと，既存のYouTubeライブ配信．公開マップへのテスト送信は行わない．

## 構成

- `qzss-stream.service`：Xvfb・Chrome・FFmpegを監視し，終了時は再起動する．1280×720・15fps・H.264 1.5Mbps・無音AAC．
- 同じエンコード結果をteeでRTMPSとHLSリングへ出力する．HLSは10秒単位，18個の一覧と削除猶予を保持．ネットワーク側はFIFOで再接続を試み，録画を継続する．
- `qzss-clips.service`：本番WebSocketを読み取り専用で購読し，緊急地震速報・震源・震度・津波・通常Jアラートで自動録画を開始する．取消，公式訓練，テスト通報，古い再送は除外．同一内容の繰り返しを48時間重複排除する．
- 通報の60秒前から900秒後までを保存する．動画片単位のため前後に最大約10秒の余裕が付く．録画起動直後や障害時に不足した区間はメタデータと投稿説明へ記録する．
- 重なる続報は1本にまとめ，最後の受信から900秒後まで延長する．1本の対象区間は約30分までとし，以後は別のクリップになる．
- `youtube-oauth.json` がなければMP4を保存して投稿待ちにする．認証後は限定公開で自動投稿する．ストリームキーだけでは動画投稿はできない．
- 投稿は再開可能なアップロードを使い，最終応答を受け取れなかった場合も既存セッションを照会して重複投稿を避ける．期限切れ等で結果が曖昧なジョブは `blocked` として残す．
- 投稿済み動画はVMで3日保持して削除．未投稿は自動削除しないが，クリップ合計3GiBまたはディスク空き2GiB未満で新規トリガーを抑止する．これは録画欠落につながるので，認証・キュー詰まりは解消する必要がある．

## VMでの操作

```bash
sudo systemctl status qzss-stream qzss-clips --no-pager
sudo journalctl -u qzss-clips -n 30 --no-pager
python3 /opt/qzss-stream/event_clips.py trigger --label '手動での録画確認'
```

手動トリガーはテスト動画として明示して投稿する．録画とメタデータは `~/qzss-stream/clips/<ID>/`．FFmpegの非公開ログにはストリームキーが含まれる可能性があるため，そのまま共有しない．

## Macでの投稿認証

プロジェクト `qzss-501907` でYouTube Data API v3を有効化済み．Google Auth PlatformでOAuthクライアントを「デスクトップアプリ」として作成し，JSONをMacへダウンロードする．

```bash
python3 /Users/syunpei/Desktop/map/tools/oci-youtube-stream/authorize-upload.py "$HOME/Downloads/qzss-youtube-client.json"
```

表示されたURLをブラウザで開き，正しい投稿先チャンネルで `youtube.upload` と `youtube.force-ssl` を許可する．概要欄編集の追加権限がない既存認証では，投稿のみ継続する．認証情報はSSHの標準入力でVMへ送り，権限0600で保存する．ブラウザの自動操作は行わない．外部アプリの公開状態がTestingの場合，更新トークンは通常7日で失効するため，継続運用前にGoogle Auth Platformの公開状態・必要な審査を確認する．

## 検証

```bash
python3 -m unittest discover -s tools/oci-youtube-stream/clip-tests -v
bash -n tools/oci-youtube-stream/run.sh tools/oci-youtube-stream/install.sh
```

VM上でも，短縮した前後区間の動画生成，FLVとMP4のデコード，公開WebSocketの読み取りを確認．YouTubeへの実投稿は本人のOAuth認証が完了するまで未検証．OS全体の停止は検知しない．ブラウザの白画面・時計停止は後述の監視で検知する．

## ライブ概要欄への録画リンク追記

追加認証後，投稿完了から通常60秒以内に，配信中のライブの末尾へ `[過去の情報はこちら]`〜`[録画一覧ここまで]` を更新する．日時・曜日・情報種別・場所は動画タイトルと同じで，次の行に限定公開動画のURLを記載する．新しい録画が上になり，APIの5000バイト上限に収まらない古い項目は概要欄の一覧から外す．動画自体は削除しない．

対象は認証したチャンネルで配信中のライブが1件の場合のみ．未配信・同時配信が複数の場合は待機して再試行する．既存説明文，タイトル，タグ，言語，公開範囲を維持し，初回更新前のsnippetをVMの `live-description-backups/<配信ID>.json` に保存する．手動編集するときは一覧の開始・終了マーカーを両方残す．更新中の同時編集は避ける．

リンク追記の失敗と動画投稿は別管理とし，失敗しても同じ動画を再投稿しない．更新応答が失われた場合は再取得した概要欄でURLを照合する．通信失敗は最大1時間の間隔で再試行する．以前の投稿済み録画もVMにジョブが残っていれば追記対象になる．単なるカラーバーの接続テストは `archive_excluded` で除外する．既存のローカル保存期限は3日なので，それ以上の障害ではジョブの手動復旧が必要になる．

テストは9件合格．実際の概要欄編集は追加認証後に確認する．認証待ちの間も配信と既存の動画投稿は継続する．

## ブラウザ画面と時計の監視

`browser_guard.py` がChromeを起動し，起動猶予60秒後から約15秒ごとに地図ページを検査する．デバッグポート9222はVM内のループバックのみ．画面の時計とVMの日本時間の差を5秒以内か確認し，DOMの時計が止まった場合と実画面がほぼ白一色の場合を異常とする．3回連続の異常でChromeだけを再起動するため，FFmpegとYouTubeへの接続を維持して復旧を試みる．Chrome自体が終了した場合も再起動する．初回の機能適用では配信サービスの再起動が必要．

VMのNTP同期を有効化し，OCIの時刻サーバー169.254.169.254へ最大300秒間隔で同期する．OSとChromeをAsia/Tokyoにし，Chromeの省電力用バックグラウンドタイマー抑制を無効化する．最新の確認結果はVMの `~/qzss-stream/browser-health.json` に保存する．

これは撮影元の時計停止・時差・白画面に対する対策で，YouTubeの配信遅延・巻き戻し視聴をなくすものではない．メモリ不足やOS停止などChrome以外の障害の完全復旧は保証しない．

## 自動更新の運用

2026年11月13日（金）から，ユーザーの希望によりVMのAPT自動更新を停止した．有効値は `/etc/apt/apt.conf.d/99qzss-manual-updates`，`apt-daily-upgrade.timer` はdisabled．更新一覧取得は継続するが，OS・Chrome等の更新適用はメンテナンス時に手動で行う．needrestartの `/etc/needrestart/conf.d/qzss.conf` で配信・録画サービスの自動再起動を除外した．新規VMを作る際は同じ運用設定を再適用する必要がある．

## 公開版の自動反映

qzss-version-watch.serviceが60秒ごとにapp-version.jsとブラウザ内QZSS_APP_VERSIONを比較する．版が違い，地図が初期化済みでactiveEventsが0件ならPage.reload(ignoreCache=true)を実行する．配信エンコーダーを再起動しない．災害情報表示中・通信失敗時・初期化中は延期し，再読み込みの最小間隔は300秒．判定結果は~/qzss-stream/version-watch.json．再読み込み成功は次回の版一致で確認する．同じ版番号のまま配布した変更は検知しないため，RELEASING.mdを守る．
