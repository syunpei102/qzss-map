#!/bin/bash
# 本番用ワンショット起動スクリプト(クラウドを使わず、同じマシンで
# 受信機の取り込みと配信サーバの両方を動かす場合)。
# u-bloxのGNSS受信機をUSBケーブルで接続した状態で実行する。
#
# クラウド(Google Cloud Run)にサーバーを置き、ラズパイから送信する
# 構成にしたい場合は、代わりに start_pi.sh を使ってください。
#
# 使い方:
#   ./start_prod.sh /dev/tty.usbserial-XXXX [ボーレート(省略時 115200)]
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="$1"
BAUDRATE="${2:-115200}"

if [ -z "$PORT" ]; then
  echo "使い方: $0 <シリアルポート> [ボーレート]"
  echo "例:     $0 /dev/tty.usbserial-1410 115200"
  echo ""
  echo "接続中のシリアルポート候補:"
  ls /dev/tty.* 2>/dev/null | grep -Ei "usb|serial" || echo "  (見つかりませんでした。受信機がUSBで接続されているか確認してください)"
  exit 1
fi

if [ ! -e "$PORT" ]; then
  echo "❌ ポート $PORT が見つかりません。受信機の接続を確認してください。"
  exit 1
fi

if [ ! -p qzss_pipe ]; then
  echo "📡 FIFO(qzss_pipe) を作成します"
  mkfifo qzss_pipe
fi

if [ ! -d node_modules ]; then
  echo "📦 npm install を実行します"
  npm install
fi

if [ ! -d venv ]; then
  echo "🐍 Python venv が無いので作成します (azarashi, pyserial を導入)"
  python3 -m venv venv
  ./venv/bin/pip install -q -r requirements.txt
fi

echo "📡 サーバー起動 (静的配信+WebSocket, port 8080)"
LOCAL_STATE_ONLY=true node server.js &
SERVER_PID=$!

function cleanup() {
  echo "🛑 サーバー停止"
  kill "$SERVER_PID" "$READER_PID" 2>/dev/null
  exit
}
trap cleanup SIGINT SIGTERM

sleep 1
open "http://localhost:8080/"

echo "🛰️  受信機からの取り込みを開始 ($PORT @ $BAUDRATE)"
./venv/bin/python3 read_legacy.py "$PORT" "$BAUDRATE" &
READER_PID=$!

wait
