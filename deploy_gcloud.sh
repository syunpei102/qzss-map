#!/bin/bash
# Google Cloud Run へのデプロイ用ワンショットスクリプト。
# 事前に `gcloud auth login` と `gcloud config set project <プロジェクトID>` を
# 済ませておくこと。実行するとその場でデプロイが走るので、内容を確認してから実行してください。
#
# 使い方:
#   INGEST_TOKEN=好きな秘密文字列 ./deploy_gcloud.sh [サービス名] [リージョン]
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SERVICE_NAME="${1:-qzss-map}"
REGION="${2:-asia-northeast1}"

if [ -z "$INGEST_TOKEN" ]; then
  echo "❌ INGEST_TOKEN が未設定です。ラズパイからの送信を認証する秘密トークンを決めて指定してください。"
  echo "   例: INGEST_TOKEN=\$(openssl rand -hex 16) ./deploy_gcloud.sh"
  exit 1
fi

ENV_VARS="INGEST_TOKEN=$INGEST_TOKEN"
if [ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ]; then
  ENV_VARS="$ENV_VARS,VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY"
else
  echo "ℹ️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定のため、プッシュ通知は無効のままデプロイします。"
fi

# このスクリプトは --set-env-vars (置き換え)を使うため、/device-admin用の
# 環境変数もここで明示的に渡さないと、次回デプロイ時に無言で消えてしまう
if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD_HASH" ] && [ -n "$SESSION_SECRET" ]; then
  ENV_VARS="$ENV_VARS,ADMIN_EMAIL=$ADMIN_EMAIL,ADMIN_PASSWORD_HASH=$ADMIN_PASSWORD_HASH,SESSION_SECRET=$SESSION_SECRET"
else
  echo "ℹ️  ADMIN_EMAIL / ADMIN_PASSWORD_HASH / SESSION_SECRET が未設定のため、/device-admin は無効のままデプロイします。"
fi

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "$ENV_VARS"

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')

echo ""
echo "✅ デプロイ完了: $URL"
echo ""
echo "ラズパイ側 (start_pi.sh) では以下を設定してください:"
echo "  export QZSS_CLOUD_URL=\"$URL/ingest\""
echo "  export QZSS_INGEST_TOKEN=\"$INGEST_TOKEN\""
