#!/usr/bin/env bash
# =====================================================================
# Деплой Instagram-бота в Yandex Cloud (каталог Даши).
# Отдельная функция, отдельный API Gateway — деплой записи (yc/deploy.sh)
# не запускается и не изменяется.
#
# Использование:
#   FOLDER_ID=b1g5f3ibgkjuf25m2vp9 \
#   YDB_ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135 \
#   YDB_DATABASE=/ru-central1/xxxx/yyyy \
#   JWT_SECRET='тот-же-секрет-что-у-функции-записи' \
#   IG_VERIFY_TOKEN='строка-для-Meta-webhook' \
#   IG_APP_SECRET='...' IG_APP_ID='...' \
#   ./ig-bot/deploy.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

: "${FOLDER_ID:?Укажите FOLDER_ID}"
: "${YDB_ENDPOINT:?Укажите YDB_ENDPOINT}"
: "${YDB_DATABASE:?Укажите YDB_DATABASE}"
: "${JWT_SECRET:?Укажите JWT_SECRET (тот же, что у функции записи)}"
: "${IG_VERIFY_TOKEN:?Укажите IG_VERIFY_TOKEN}"
FN_NAME=daria-ig-bot
SA_NAME=daria-booking-sa   # тот же сервисный аккаунт: доступ к той же YDB

# 1. Сервисный аккаунт (создан деплоем записи; создаём, если запускают отдельно)
if ! yc iam service-account get "$SA_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc iam service-account create --name "$SA_NAME" --folder-id "$FOLDER_ID"
  yc resource-manager folder add-access-binding "$FOLDER_ID" --role ydb.editor --subject "serviceAccount:$(yc iam service-account get "$SA_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')" || true
fi
SA_ID=$(yc iam service-account get "$SA_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. Функция бота
if ! yc serverless function get "$FN_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc serverless function create --name "$FN_NAME" --folder-id "$FOLDER_ID"
fi
zip -qr fn-ig.zip index.js package.json
yc serverless function version create \
  --function-name "$FN_NAME" --folder-id "$FOLDER_ID" \
  --runtime nodejs18 --entrypoint index.handler \
  --memory 256m --execution-timeout 15s \
  --service-account-id "$SA_ID" \
  --source-path fn-ig.zip \
  --environment "YDB_ENDPOINT=$YDB_ENDPOINT,YDB_DATABASE=$YDB_DATABASE,JWT_SECRET=$JWT_SECRET,IG_VERIFY_TOKEN=$IG_VERIFY_TOKEN${IG_APP_SECRET:+,IG_APP_SECRET=$IG_APP_SECRET}${IG_APP_ID:+,IG_APP_ID=$IG_APP_ID}"
rm -f fn-ig.zip
yc serverless function allow-unauthenticated-invoke "$FN_NAME" --folder-id "$FOLDER_ID"
FN_ID=$(yc serverless function get "$FN_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 3. API Gateway бота (отдельный от шлюза записи)
GW_NAME=daria-ig-gw
sed "s/__FUNCTION_ID__/$FN_ID/;s/__SA_ID__/$SA_ID/" apigw.yaml > /tmp/apigw-ig.yaml
if yc serverless api-gateway get "$GW_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc serverless api-gateway update "$GW_NAME" --folder-id "$FOLDER_ID" --spec /tmp/apigw-ig.yaml
else
  yc serverless api-gateway create --name "$GW_NAME" --folder-id "$FOLDER_ID" --spec /tmp/apigw-ig.yaml
fi

# 4. Таймер продления токена: раз в сутки в 04:00 UTC (07:00 МСК)
TRIGGER_NAME=daria-ig-token-refresh
if ! yc serverless trigger get "$TRIGGER_NAME" --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
  yc serverless trigger create timer --name "$TRIGGER_NAME" --folder-id "$FOLDER_ID" \
    --cron-expression '0 4 ? * * *' \
    --invoke-function-name "$FN_NAME" --invoke-function-service-account-id "$SA_ID"
fi

yc serverless api-gateway get "$GW_NAME" --folder-id "$FOLDER_ID" --format json | python3 -c 'import sys,json;d=json.load(sys.stdin)["domain"];print("IG API URL: https://"+d);print("Webhook URL для Meta: https://"+d+"/api/ig/webhook")'

echo "Готово. Подставьте IG API URL в yc/admin/index.html (переменная IG_API_URL)."
