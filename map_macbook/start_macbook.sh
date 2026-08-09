#!/bin/bash
# このMacBook単体で「受信機からの取り込み → デコード → 地図表示」を
# 全部ローカルで完結させるワンショット起動スクリプト。
# 出張・旅行などで自宅のラズパイ拠点(qzss01)を使えない時に、同じ
# 受信機(USBシリアル)をこのMacに挿して代わりに使う想定。
# インターネット接続やCloud Runには一切依存しない(地図アプリを
# このMac上でLOCAL_STATE_ONLYモードで起動し、そこへ受信機から直接送る)。
#
# 前提: 受信機(USBシリアル、CH340等)をこのMacに接続しておくこと。
#
# 使い方:
#   ./start_macbook.sh                              # ポート自動検出
#   ./start_macbook.sh /dev/tty.usbserial-XXXX       # ポート指定
#   ./start_macbook.sh /dev/tty.usbserial-XXXX 9600  # ポート+ボーレート指定
#
# 終了するには、受信機の取り込みを表示しているターミナルで Ctrl+C。
# (地図アプリのバックグラウンドプロセスも連動して終了する)
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
MAP_DIR="$(cd "$DIR/.." && pwd)"
PI_DIR="$MAP_DIR/qzss_pi_package"

HTTP_PORT="${HTTP_PORT:-8080}"
PORT_ARG="$1"
BAUDRATE="${2:-9600}"

# ポートが指定されていなければ自動検出する。macOSのUSBシリアル命名規則
# (受信機のCH340変換チップはwchusbserial、その他FTDI等はusbserialという
# 名前で/dev/tty.*・/dev/cu.*に出てくる)に合わせて候補を広めに探す
if [ -z "$PORT_ARG" ]; then
  candidates=()
  for pattern in /dev/tty.usbserial-* /dev/tty.wchusbserial* /dev/tty.usbmodem* \
                 /dev/cu.usbserial-* /dev/cu.wchusbserial* /dev/cu.usbmodem*; do
    [ -e "$pattern" ] && candidates+=("$pattern")
  done
  if [ "${#candidates[@]}" -eq 1 ]; then
    PORT_ARG="${candidates[0]}"
    echo "🔌 受信機を自動検出しました: $PORT_ARG"
  elif [ "${#candidates[@]}" -gt 1 ]; then
    echo "❌ シリアルポート候補が複数見つかりました。使うポートを指定して実行し直してください:"
    printf '   %s\n' "${candidates[@]}"
    exit 1
  else
    echo "❌ 受信機(USBシリアル)が見つかりません。接続を確認するか、ポートを直接指定してください:"
    echo "   $0 /dev/tty.usbserial-XXXX [ボーレート]"
    exit 1
  fi
fi

if [ ! -e "$PORT_ARG" ]; then
  echo "❌ ポート $PORT_ARG が見つかりません。受信機の接続を確認してください。"
  exit 1
fi

# Python venv(azarashi, pyserial)。qzss_pi_package側と共用する
# (無ければ初回だけ作成する。既にPiと同じこのリポジトリで作成済みなら
# そのまま使う)
if [ ! -d "$PI_DIR/venv" ]; then
  echo "🐍 Python venv が無いので作成します (azarashi, pyserial を導入)"
  python3 -m venv "$PI_DIR/venv"
  "$PI_DIR/venv/bin/pip" install -q -r "$PI_DIR/requirements.txt"
fi

# Node依存関係
if [ ! -d "$MAP_DIR/node_modules" ]; then
  echo "📦 npm install します"
  (cd "$MAP_DIR" && npm install)
fi

echo "🗺️  地図アプリをローカルで起動します (port $HTTP_PORT)"
# LOCAL_STATE_ONLY=true: GCS(クラウドの永続化ストレージ)に一切
# アクセスしない。旅行先でネット接続が不安定・無くても地図アプリ自体は
# 問題なく動く(状態はこのMac上のファイルにのみ保存される)
(cd "$MAP_DIR" && PORT="$HTTP_PORT" LOCAL_STATE_ONLY=true node server.js > /tmp/qzss_map_macbook.log 2>&1) &
MAP_PID=$!
trap 'echo; echo "🛑 地図アプリを終了します"; kill "$MAP_PID" 2>/dev/null' EXIT

echo "⏳ 地図アプリの起動を待っています…"
for i in $(seq 1 30); do
  if curl -fs "http://localhost:${HTTP_PORT}/" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# localhost/127.0.0.1でアクセスすると、ラズパイの無人kiosk画面向けの
# 判定(public/main.jsのIS_LOCAL_KIOSK)が働いてしまい、タップ・ズーム等の
# 操作を受け付けない表示専用モードになる。手元で普通に操作して確認
# したいので、LAN IPでアクセスして通常のWeb版として開く
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
[ -z "$LAN_IP" ] && LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  echo "⚠️ LAN IPが取得できませんでした(Wi-Fi未接続の可能性)。localhostで開きますが、この場合タップ・ズーム操作ができないキオスク表示になります"
  MAP_URL="http://localhost:${HTTP_PORT}"
else
  MAP_URL="http://${LAN_IP}:${HTTP_PORT}"
fi

echo "🌐 ブラウザで開きます: $MAP_URL"
open "$MAP_URL" 2>/dev/null || echo "   (自動で開けませんでした。手動でこのURLを開いてください: $MAP_URL)"

echo
echo "🛰️  受信機からの取り込みを開始します ($PORT_ARG @ $BAUDRATE)"
echo "   生データ(NMEA/QZQSM電文)とデコード結果(JSON)をこの下に流します"
echo "   終了するには Ctrl+C"
echo "-------------------------------------------------------------"
QZSS_CLOUD_URL="http://localhost:${HTTP_PORT}/ingest" \
  QZSS_VERBOSE_DECODE=1 \
  "$PI_DIR/venv/bin/python3" "$PI_DIR/read_legacy_dual.py" "$PORT_ARG" "$BAUDRATE"
