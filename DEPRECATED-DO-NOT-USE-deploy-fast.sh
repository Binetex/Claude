#!/usr/bin/env bash
# ⚠️ DEPRECATED — НЕ ИСПОЛЬЗОВАТЬ. Заменён единым git-деплоем deploy.sh (git reset --hard origin/main).
echo "DEPRECATED: используйте ./deploy.sh (git-based). rsync-деплой из локальной папки отключён." >&2; exit 1
# deploy-fast.sh — Solo-dev быстрый деплой Floremart.
#
# Копирует ТЕКУЩУЮ ЛОКАЛЬНУЮ рабочую папку напрямую на production через rsync --delete.
# БЕЗ GitHub. БЕЗ git pull/fetch/reset/commit/push. Старый deploy.sh не используется.
#
# ВНИМАНИЕ: после deploy-fast.sh production ОПЕРЕЖАЕТ GitHub.
# GitHub обновляется отдельно и вручную, когда нужно сохранить стабильную версию.

set -euo pipefail

# ---------- Конфигурация ----------
LOCAL_DIR="/Users/belford/Claude Code/florist-dashboard"
SSH_KEY="$HOME/.ssh/floremart_deploy"
SSH_HOST="claudecode@74.214.175.249"
PROD_DIR="/home/claudecode/htdocs/floremart.com"
PROD_BASENAME="floremart.com"          # ожидаемое имя папки назначения
PM2_NAME="floremart"
SITE_URL="https://floremart.com"
NVM_DIR_REMOTE="/home/floremart/.nvm"
NODE_FALLBACK_BIN="/home/floremart/.nvm/versions/node/v24.18.0/bin"

SSH="ssh -i $SSH_KEY $SSH_HOST"

# ---------- 0. Локальные проверки ----------
if [ ! -f "$LOCAL_DIR/package.json" ]; then
  echo "ОШИБКА: в '$LOCAL_DIR' нет package.json — это не папка проекта. Прерываю." >&2
  exit 1
fi

# ---------- 1. Guard: destination строго = папка Floremart (перед --delete) ----------
echo "==> [1/4] Проверка destination перед rsync --delete"
if [ "$PROD_DIR" != "/home/claudecode/htdocs/floremart.com" ]; then
  echo "ОШИБКА: PROD_DIR='$PROD_DIR' не совпадает с ожидаемым путём Floremart. Прерываю." >&2
  exit 1
fi
if [ "$(basename "$PROD_DIR")" != "$PROD_BASENAME" ]; then
  echo "ОШИБКА: basename destination != '$PROD_BASENAME'. Прерываю." >&2
  exit 1
fi
# Удалённая проверка: путь существует, это каталог, и внутри лежит именно этот проект.
GUARD=$($SSH "bash -s" <<REMOTE_GUARD
set -e
[ -d "$PROD_DIR" ] || { echo "NOT_A_DIR"; exit 0; }
[ -f "$PROD_DIR/package.json" ] || { echo "NO_PACKAGE_JSON"; exit 0; }
if grep -q '"name": "florist-dashboard"' "$PROD_DIR/package.json" 2>/dev/null; then
  echo "OK"
else
  echo "WRONG_PROJECT"
fi
REMOTE_GUARD
)
if [ "$GUARD" != "OK" ]; then
  echo "ОШИБКА guard: удалённая папка не подтверждена как Floremart (ответ: '$GUARD'). Прерываю БЕЗ --delete." >&2
  exit 1
fi
echo "    destination подтверждён: $SSH_HOST:$PROD_DIR"

# ---------- 2. rsync --delete (исключённые пути НЕ удаляются) ----------
echo "==> [2/4] rsync локальной папки -> production (--delete)"
# --no-perms / --omit-dir-times: claudecode не владелец каталога сайта (только групповой
# доступ), поэтому не пытаемся выставлять права/время на сам каталог — иначе rsync падает.
rsync -az --no-perms --omit-dir-times --delete -e "ssh -i $SSH_KEY" \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.next' \
  --exclude='.next.previous' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='coverage/' \
  --exclude='logs/' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  --exclude='*.swp' --exclude='*.swo' --exclude='*~' --exclude='.*.swp' \
  --exclude='.idea/' --exclude='.vscode/' \
  --exclude='public/uploads/' \
  --exclude='.deploy-fast.deps.hash' \
  "$LOCAL_DIR"/ "$SSH_HOST:$PROD_DIR/"

# ---------- 3. Сборка и рестарт на сервере ----------
echo "==> [3/4] Шаги на сервере"
$SSH "bash -s" <<REMOTE
set -euo pipefail
cd "$PROD_DIR"

# --- Node.js 20+ ---
export NVM_DIR="$NVM_DIR_REMOTE"
if [ -s "\$NVM_DIR/nvm.sh" ]; then . "\$NVM_DIR/nvm.sh"; fi
if command -v nvm >/dev/null 2>&1; then nvm use 24 >/dev/null 2>&1 || true; fi
if ! command -v node >/dev/null 2>&1; then export PATH="$NODE_FALLBACK_BIN:\$PATH"; fi
NODE_MAJOR=\$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "\$NODE_MAJOR" -lt 20 ]; then
  echo "ОШИБКА: Node \$(node -v) < 20. Прерываю." >&2; exit 1
fi
echo "Node: \$(node -v)  npm: \$(npm -v)"

# --- npm ci только при изменении package.json / lock ---
HASH_FILE=".deploy-fast.deps.hash"
NEW_HASH=\$(md5sum package.json package-lock.json 2>/dev/null | md5sum | awk '{print \$1}')
if [ ! -f "\$HASH_FILE" ] || [ "\$(cat "\$HASH_FILE" 2>/dev/null)" != "\$NEW_HASH" ]; then
  echo "==> Зависимости изменились -> npm ci"
  npm ci
  echo "\$NEW_HASH" > "\$HASH_FILE"
else
  echo "==> package.json/lock без изменений -> npm ci пропущен"
fi

# --- Prisma client (всегда) ---
echo "==> prisma generate"
npx prisma generate

# --- Проверка миграций БЕЗ автоприменения ---
echo "==> Статус миграций Prisma"
if npx prisma migrate status 2>&1 | tee /tmp/floremart_migstatus.txt | grep -qi "not yet been applied"; then
  echo ""
  echo "!!! ОСТАНОВКА: есть неприменённые миграции Prisma:"
  grep -iE "^[[:space:]]*[0-9]{14}_" /tmp/floremart_migstatus.txt || true
  echo "migrate deploy автоматически НЕ запускается (сборка и рестарт пропущены)."
  echo "Подтверди применение и выполни вручную:"
  echo "  cd $PROD_DIR && npx prisma migrate deploy"
  echo "затем повтори быстрый деплой."
  exit 3
fi

# --- Безопасная сборка: активная .next не удаляется до успеха ---
echo "==> Пересборка (безопасная схема через .next.previous)"
rm -rf .next.previous
if [ -e .next ]; then mv .next .next.previous; fi
if npm run build; then
  echo "==> build OK — удаляю .next.previous"
  rm -rf .next.previous
else
  echo "!!! BUILD FAILED — возвращаю предыдущую сборку, PM2 НЕ перезапускается" >&2
  rm -rf .next
  if [ -e .next.previous ]; then mv .next.previous .next; fi
  exit 4
fi

# --- Рестарт только при успешной сборке ---
echo "==> pm2 restart $PM2_NAME --update-env"
pm2 restart "$PM2_NAME" --update-env
pm2 list | grep -iE "name|$PM2_NAME" || true
REMOTE

# ---------- 4. Проверка HTTP 200 ----------
echo "==> [4/4] Проверка HTTP 200"
code=""
for i in 1 2 3 4 5 6; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE_URL" || true)
  echo "  попытка $i: HTTP $code"
  [ "$code" = "200" ] && break
  sleep 3
done
if [ "$code" = "200" ]; then
  echo "✅ Готово: $SITE_URL отвечает 200"
else
  echo "⚠️  $SITE_URL не отдал 200 (последний код: $code)."
  echo "    Логи: $SSH 'pm2 logs $PM2_NAME --lines 40 --nostream'"
  exit 5
fi
