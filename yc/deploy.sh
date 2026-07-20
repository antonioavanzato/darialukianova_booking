#!/usr/bin/env bash
# =====================================================================
# Деплой API записи в Yandex Cloud (каталог Даши).
# Требуется: установленный и авторизованный yc CLI (yc init),
# привязанный платёжный аккаунт, созданная YDB serverless.
#
# Использование:
#   FOLDER_ID=b1g5f3ibgkjuf25m2vp9 \
#   YDB_ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135 \
#   YDB_DATABASE=/ru-central1/xxxx/yyyy \
#   ADMIN_PASSWORD='пароль-для-Даши' \
#   TELEGRAM_TOKEN='...' TELEGRAM_CHAT_ID='...' \
#   ./deploy.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

: "${FOLDER_ID:?Укажите FOLDER_ID}"
: "${YDB_ENDPOINT:?Укажите YDB_ENDPOINT}"
: "${YDB_DATABASE:?Укажите YDB_DATABASE}"
: "${ADMIN_PASSWORD:?Укажите ADMIN_PASSWORD}"
JWT_SECRET="${JWT_SECRET:-$(head -c 32 /dev/urandom | base64)}"
FN_NAME=daria-booking-api
SA_NAME=daria-booking-sa

# 1. Сервисный аккаунт с доступом к YDB
if ! yc iam service-account get "$SA_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc iam service-account create --name "$SA_NAME" --folder-id "$FOLDER_ID"
fi
SA_ID=$(yc iam service-account get "$SA_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
yc resource-manager folder add-access-binding "$FOLDER_ID" --role ydb.editor --subject "serviceAccount:$SA_ID" || true

# 2. Функция
if ! yc serverless function get "$FN_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc serverless function create --name "$FN_NAME" --folder-id "$FOLDER_ID"
fi
(cd backend && zip -qr ../fn.zip index.js package.json)
yc serverless function version create \
  --function-name "$FN_NAME" --folder-id "$FOLDER_ID" \
  --runtime nodejs18 --entrypoint index.handler \
  --memory 256m --execution-timeout 15s \
  --service-account-id "$SA_ID" \
  --source-path fn.zip \
  --environment "YDB_ENDPOINT=$YDB_ENDPOINT,YDB_DATABASE=$YDB_DATABASE,ADMIN_PASSWORD=$ADMIN_PASSWORD,JWT_SECRET=$JWT_SECRET,TELEGRAM_TOKEN=${TELEGRAM_TOKEN:-},TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}"
rm -f fn.zip
yc serverless function allow-unauthenticated-invoke "$FN_NAME" --folder-id "$FOLDER_ID"
FN_ID=$(yc serverless function get "$FN_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 3. API Gateway
GW_NAME=daria-booking-gw
sed "s/__FUNCTION_ID__/$FN_ID/;s/__SA_ID__/$SA_ID/" apigw.yaml > /tmp/apigw.yaml
if yc serverless api-gateway get "$GW_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc serverless api-gateway update "$GW_NAME" --folder-id "$FOLDER_ID" --spec /tmp/apigw.yaml
else
  yc serverless api-gateway create --name "$GW_NAME" --folder-id "$FOLDER_ID" --spec /tmp/apigw.yaml
fi
yc serverless api-gateway get "$GW_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;print("API URL: https://"+json.load(sys.stdin)["domain"])'

echo "Готово. Подставьте API URL в yc/admin/index.html и yc/form/form-block.html (переменная API_URL)."
