#!/bin/sh
# Одноразовая тестовая БД для интеграционных тестов.
#
# Поднимает prisma dev (если ещё не поднят), накатывает миграции и печатает готовую строку
# запуска тестов. Процедура раньше жила только в памяти и пересобиралась руками после каждого
# падения инстанса — теперь она одна и записана.
#
#   npm run test:db          — поднять и напечатать команду
#   npx prisma dev stop --name fm-test   — погасить
set -e
npx prisma dev --name fm-test --detach >/dev/null 2>&1 || true
PORT=$(npx prisma dev ls 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -A 12 "fm-test" | grep -oE "localhost:[0-9]+/template1" | head -1 | sed 's|localhost:||; s|/template1||')
if [ -z "$PORT" ]; then echo "Не удалось поднять prisma dev" >&2; exit 1; fi
URL="postgres://postgres:postgres@localhost:$PORT/postgres?sslmode=disable"
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy >/dev/null
echo "Тестовая БД готова: $URL"
echo
echo "Запуск тестов:"
echo "  DATABASE_URL='$URL' CREDENTIALS_ENCRYPTION_KEY=\"\$(openssl rand -base64 32)\" npx vitest run --no-file-parallelism"
