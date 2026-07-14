#!/bin/bash
# 実機の受信機からクラウド(Cloud Run)へ送信する一発起動スクリプト。
# ポート名だけ指定すれば、あらかじめ設定済みのURL/トークンで
# read_legacy.py を起動する(地図の描画自体はCloud Run側が行う)。
#
# 使い方:
#   ./start_receiver.sh /dev/tty.usbserial-10 [ボーレート(既定9600)]
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="$1"
BAUDRATE="${2:-9600}"

export QZSS_CLOUD_URL="https://qzss-map-85436528666.asia-northeast1.run.app/ingest"
export QZSS_INGEST_TOKEN="4552855f00070aecee0278b9ba8dbc7c"

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
