#!/bin/sh
# Одноразовая тестовая БД для интеграционных тестов.
#
# Порт берётся из server.json САМОГО инстанса (у каждого имени свой каталог состояния),
# а не выуживается grep'ом из pretty-таблицы `prisma dev ls`: там окно поиска при
# неподнявшемся инстансе дотягивалось до порта СОСЕДНЕЙ базы, и миграции молча уезжали
# в неё. Задать порт заранее нельзя — prisma dev 0.16.28 игнорирует -P/--db-port.
#
# Каждый запуск даёт ЧИСТУЮ базу: старый инстанс удаляется целиком (`rm`, не `stop` —
# stop сохраняет состояние, и прогоны зависели бы от осадка прошлых).
#
#   npm run test:db                     — поднять и напечатать команду запуска тестов
#   npx prisma dev stop fm-test         — погасить
set -e
NAME=fm-test

npx prisma dev stop "$NAME" >/dev/null 2>&1 || true
npx prisma dev rm "$NAME" >/dev/null 2>&1 || true
# Старт БЕЗ глушения ошибок: не поднялась — это провал скрипта, а не повод искать чужой порт.
npx prisma dev --name "$NAME" --detach >/dev/null

STATE_DARWIN="$HOME/Library/Application Support/prisma-dev-nodejs/$NAME/server.json"
STATE_LINUX="${XDG_DATA_HOME:-$HOME/.local/share}/prisma-dev-nodejs/$NAME/server.json"
if [ -f "$STATE_DARWIN" ]; then STATE="$STATE_DARWIN"; else STATE="$STATE_LINUX"; fi
i=0
until [ -f "$STATE" ]; do
  i=$((i + 1))
  [ "$i" -ge 10 ] && { echo "Инстанс $NAME не оставил состояния: нет $STATE" >&2; exit 1; }
  sleep 1
done
PORT=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).databasePort" "$STATE")
URL="postgres://postgres:postgres@localhost:$PORT/postgres?sslmode=disable"

# --detach возвращается раньше, чем постгрес готов принимать соединения.
i=0
until DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 15 ] && { echo "БД на порту $PORT не приняла миграции за $i попыток" >&2; exit 1; }
  sleep 2
done

# Условленное место, где порт ждут другие инструменты.
printf '%s' "$PORT" > "${TMPDIR:-/tmp}/fmport"

echo "Тестовая БД готова: $URL"
echo
echo "Запуск тестов:"
echo "  DATABASE_URL='$URL' CREDENTIALS_ENCRYPTION_KEY=\"\$(openssl rand -base64 32)\" npx vitest run --no-file-parallelism"
