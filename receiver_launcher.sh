# 各start_*.shから source される共通の受信プロセス起動処理(Issue #19)．
#
# 正式な受信実装は別リポジトリ(syunpei102/qzss-pi-package)の read_legacy_dual.py
# (非同期送信・keep-alive・時間制重複抑止・未知衛星/NMEA/UBX対策を含む)．
# 起動方法ごとに実装が分岐しないよう，この共通処理は必ずそれへ委譲する．
# このリポジトリの read_legacy.py は，同じ不具合修正を持たせた互換・検証用の
# 実装で，正式実装が見つからない場合に QZSS_ALLOW_LEGACY_RECEIVER=1 を明示した
# ときだけ使う．
#
# 使い方(呼び出し側で DIR を設定済みであること):
#   source "$DIR/receiver_launcher.sh"
#   receiver_exec <シリアルポート> <ボーレート> [--nmea]     # 現プロセスを置き換える
#   ( receiver_exec ... ) &                                  # バックグラウンド起動
receiver_exec() {
  local official_dir="${QZSS_PI_PACKAGE_DIR:-$DIR/qzss_pi_package}"
  if [ -f "$official_dir/read_legacy_dual.py" ]; then
    echo "🛰️  正式な受信実装 (qzss_pi_package/read_legacy_dual.py) を使用します"
    cd "$official_dir"
    if [ -x "$DIR/venv/bin/python3" ]; then
      exec "$DIR/venv/bin/python3" read_legacy_dual.py "$@"
    fi
    exec python3 read_legacy_dual.py "$@"
  fi
  if [ "${QZSS_ALLOW_LEGACY_RECEIVER:-}" = "1" ]; then
    echo "⚠️  正式な受信実装が見つからないため，互換実装 read_legacy.py を使用します(開発・検証用)"
    cd "$DIR"
    exec ./venv/bin/python3 read_legacy.py "$@"
  fi
  echo "❌ 正式な受信実装 $official_dir/read_legacy_dual.py が見つかりません．" >&2
  echo "   git clone https://github.com/syunpei102/qzss-pi-package.git qzss_pi_package" >&2
  echo "   (場所が異なる場合は QZSS_PI_PACKAGE_DIR を指定．開発用に互換実装を使う場合のみ QZSS_ALLOW_LEGACY_RECEIVER=1)" >&2
  exit 1
}
