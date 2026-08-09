# MacBookでローカル完結版を動かす

自宅のラズパイ拠点(qzss01)を使えない外出・旅行時に、同じ受信機(USBシリアル)を
このMacBookに挿して、受信→デコード→地図表示を全部このMac単体で完結させるための
ワンショット起動スクリプト。インターネット接続やCloud Runには一切依存しない。

## 使い方

1. 受信機(USBシリアル)をこのMacBookに接続する
2. このディレクトリで実行する:

   ```bash
   ./start_macbook.sh
   ```

   ポートは自動検出する(候補が複数見つかった場合や検出できない場合はポートを
   明示的に指定する。`ls /dev/tty.*` で確認できる):

   ```bash
   ./start_macbook.sh /dev/tty.usbserial-XXXX [ボーレート、既定9600]
   ```

3. 自動でブラウザが開き、地図が表示される
4. ターミナルには受信した生データ(NMEA/QZQSM電文)とデコード結果(JSON)が
   流れ続ける
5. 終了する時はターミナルで `Ctrl+C`(地図アプリのバックグラウンドプロセスも
   連動して終了する)

## 仕組み

- `../` (qzss-map本体)を `LOCAL_STATE_ONLY=true` で起動し、GCS等クラウドの
  永続化ストレージには一切アクセスしない(状態はこのMac上のファイルにのみ保存)
- `../qzss_pi_package/read_legacy_dual.py` が受信機からデコードし、
  ローカルの地図アプリ(`http://localhost:<port>/ingest`)へ直接送信する
- ブラウザは `localhost` ではなくLAN IPで開く(`localhost`/`127.0.0.1`だと
  ラズパイの無人kiosk画面向けの判定が働き、タップ・ズーム操作ができなくなるため)
- デコード結果の全文をターミナルに表示するのは `QZSS_VERBOSE_DECODE=1`
  環境変数による(ラズパイ本番では既定で無効、このスクリプトだけが有効にする)

## 前提

- Python venv(`../qzss_pi_package/venv`)・Node依存関係(`../node_modules`)は
  無ければ初回実行時に自動でセットアップされる
