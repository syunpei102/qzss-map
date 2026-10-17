#!/bin/bash
# Google Cloud Run へのデプロイ用ワンショットスクリプト。
# 事前に `gcloud auth login` と `gcloud config set project <プロジェクトID>` を
# 済ませておくこと。実行するとその場でデプロイが走るので、内容を確認してから実行してください。
#
# 初回デプロイ時はINGEST_TOKENが必要。再デプロイ時は省略して既存設定を維持できる。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SERVICE_NAME="${1:-qzss-map}"
REGION="${2:-asia-northeast1}"

if [ -z "${INGEST_TOKEN:-}" ] && ! gcloud run services describe "$SERVICE_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "❌ 初回デプロイにはINGEST_TOKENが必要です。例: INGEST_TOKEN=\$(openssl rand -hex 16) ./deploy_gcloud.sh"
  exit 1
fi

# --set-env-varsは既存設定を丸ごと置換し，通知・Discordの鍵を消してしまう。
# 指定した変数だけ更新し，省略された既存設定はそのまま維持する。
ENV_VARS=()
[ -n "${INGEST_TOKEN:-}" ] && ENV_VARS+=("INGEST_TOKEN=$INGEST_TOKEN")
if [ -n "${VAPID_PUBLIC_KEY:-}" ] || [ -n "${VAPID_PRIVATE_KEY:-}" ]; then
  if [ -z "${VAPID_PUBLIC_KEY:-}" ] || [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
    echo "❌ VAPID鍵は公開鍵と秘密鍵を両方指定してください。"
    exit 1
  fi
  ENV_VARS+=("VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY" "VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY")
fi
[ -n "${DISCORD_PUBLIC_KEY:-}" ] && ENV_VARS+=("DISCORD_PUBLIC_KEY=$DISCORD_PUBLIC_KEY")
[ -n "${DISCORD_ADMIN_USER_ID:-}" ] && ENV_VARS+=("DISCORD_ADMIN_USER_ID=$DISCORD_ADMIN_USER_ID")

if [ "${ENABLE_WEB_ADMIN:-}" = "true" ]; then
  if [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${ADMIN_PASSWORD_HASH:-}" ] || [ -z "${SESSION_SECRET:-}" ]; then
    echo "❌ Web管理画面を有効化する場合は管理者認証の環境変数をすべて指定してください。"
    exit 1
  fi
  ENV_VARS+=("ENABLE_WEB_ADMIN=true" "ADMIN_EMAIL=$ADMIN_EMAIL" "ADMIN_PASSWORD_HASH=$ADMIN_PASSWORD_HASH" "SESSION_SECRET=$SESSION_SECRET")
fi

# このサービスはWebSocket接続・activeReports・通知の重複抑止・デバイス状態を
# 各プロセスのメモリに持つ単一プロセス設計のため，Cloud Runは最大1インスタンスに
# 固定する(複数になると，ingestを受けたインスタンス以外の閲覧者へ配信されない)．
# 複数インスタンス化するにはPub/Sub等で配信と状態を共有する設計変更が必要．
# 同時接続数は1インスタンスに収まる範囲(CONCURRENCY，既定80)で受ける．
MAX_INSTANCES=1
CONCURRENCY="${CONCURRENCY:-80}"

DEPLOY_ARGS=(--source . --region "$REGION" --max-instances "$MAX_INSTANCES" --concurrency "$CONCURRENCY" --allow-unauthenticated)
if [ "${#ENV_VARS[@]}" -gt 0 ]; then
  DEPLOY_ARGS+=(--update-env-vars "$(IFS=,; echo "${ENV_VARS[*]}")")
fi
gcloud run deploy "$SERVICE_NAME" "${DEPLOY_ARGS[@]}"

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')

echo ""
echo "✅ デプロイ完了: $URL"
echo ""
echo "ラズパイ側の送信先: $URL/ingest"
echo "認証トークンは既存の安全な保管場所で確認してください。"
