#!/bin/bash
# ラズベリーパイ側のワンショット起動スクリプト。
# 受信機からの取り込み → デコード → 重要な通報だけをクラウドへ送信する。
# (地図の描画やWebSocket配信はクラウド側のCloud Runサービスが行う)
#
# 使い方:
#   QZSS_CLOUD_URL=https://xxxx-xxxx.a.run.app/ingest \
#   QZSS_INGEST_TOKEN=xxxxxxxx \
#   ./start_pi.sh /dev/ttyUSB0 115200
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="$1"
BAUDRATE="${2:-115200}"

if [ -z "$PORT" ] || [ -z "$QZSS_CLOUD_URL" ]; then
  echo "使い方:"
  echo "  QZSS_CLOUD_URL=https://xxxx.a.run.app/ingest QZSS_INGEST_TOKEN=xxxx $0 <シリアルポート> [ボーレート]"
  echo ""
  echo "接続中のシリアルポート候補:"
  ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || echo "  (見つかりませんでした。受信機の接続を確認してください)"
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

echo "🛰️  受信機からの取り込みを開始し、重要な通報のみ $QZSS_CLOUD_URL に送信します"
echo "   ($PORT @ $BAUDRATE)"
./venv/bin/python3 read_legacy.py "$PORT" "$BAUDRATE"
