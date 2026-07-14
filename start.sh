#!/bin/bash
# 後方互換のためのエイリアス。実体は start_demo.sh (擬似データでの動作確認用)。
# 実機を使う場合は start_prod.sh、クラウド構成のラズパイ側は start_pi.sh を使ってください。
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/start_demo.sh" "$@"
