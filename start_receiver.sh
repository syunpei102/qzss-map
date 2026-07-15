#!/bin/bash
# 実機の受信機からクラウド(Cloud Run)へ送信する一発起動スクリプト。
# ポート名を指定し、QZSS_INGEST_TOKEN を環境変数で渡してから実行する
# (read_legacy.py を起動する。地図の描画自体はCloud Run側が行う)。
#
# 秘密のトークンをこのファイルに直接書かない(公開リポジトリのため)。
# 使い方:
#   QZSS_INGEST_TOKEN=xxxxxxxx ./start_receiver.sh /dev/tty.usbserial-10 [ボーレート(既定9600)]
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="$1"
BAUDRATE="${2:-9600}"

export QZSS_CLOUD_URL="${QZSS_CLOUD_URL:-https://eq.shum10.com/ingest}"
: "${QZSS_INGEST_TOKEN:?QZSS_INGEST_TOKEN を環境変数で指定してください(例: QZSS_INGEST_TOKEN=xxxx $0 ...)}"

if [ -z "$PORT" ]; then
  echo "使い方: $0 <シリアルポート> [ボーレート(既定9600)]"
  echo ""
  echo "接続中のシリアルポート候補:"
  ls /dev/tty.* 2>/dev/null | grep -Ei "usb|serial|modem" || echo "  (見つかりませんでした。受信機の接続を確認してください)"
  exit 1
fi

if [ ! -e "$PORT" ]; then
  echo "❌ ポート $PORT が見つかりません。受信機の接続を確認してください。"
  exit 1
fi

if [ ! -d venv ]; then
  echo "🐍 Python venv が無いので作成します (azarashi, pyserial を導入)"
  python3 -m venv venv
  ./venv/bin/pip install -q -r requirements.txt
fi

echo "🛰️  受信機からの取り込みを開始し、重要な通報のみクラウドへ送信します"
echo "   ($PORT @ $BAUDRATE) -> $QZSS_CLOUD_URL"
./venv/bin/python3 read_legacy.py "$PORT" "$BAUDRATE" --nmea
