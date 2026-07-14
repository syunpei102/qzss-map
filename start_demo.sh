#!/bin/bash
# アンテナ/受信機なしで動作確認するためのワンショット起動スクリプト。
# server.js(静的配信+WebSocket配信) + test.py(擬似データ送信)を
# まとめて起動し、ブラウザを開く。Ctrl-Cで全部まとめて止まる。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

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
node server.js &
SERVER_PID=$!

echo "🧪 擬似データ送信を開始 (test.py, 5秒おき)"
./venv/bin/python3 test_tohoku_2011.py &
TEST_PID=$!

function cleanup() {
  echo "🛑 サーバー停止"
  kill "$SERVER_PID" "$TEST_PID" 2>/dev/null
  exit
}
trap cleanup SIGINT SIGTERM

sleep 1
open "http://localhost:8080/"

wait
