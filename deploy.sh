#!/usr/bin/env bash
# ЕДИНЫЙ деплой floremart.com (git-based, CloudPanel-сервер).
# Запускать ИЗ директории сайта (где лежит этот файл), под пользователем сайта.
#
# Поток: git fetch origin main → git reset --hard origin/main → npm ci (если менялись
#        зависимости) → prisma generate → prisma migrate deploy → сборка В СТОРОНЕ
#        (.next.build) → короткое окно: флаг обслуживания, подмена каталога, reload,
#        health → снятие флага. При сбое — возврат предыдущей сборки.
#
#   ./deploy.sh              — обычное обновление
#   ./deploy.sh --first-run  — первый запуск (pm2 start вместо reload)
#   ./deploy.sh --reinstall  — принудительный npm ci, даже если lock не менялся
#
# ГЛАВНОЕ ПРАВИЛО: пока идёт сборка, сайт обязан работать. Поэтому боевой `.next` НЕ
# трогается, пока новая сборка не готова целиком. Раньше он переименовывался ДО сборки —
# и полторы минуты флористы видели «Failed to load chunk» и белые экраны.
#
# НИКОГДА не выполняет: prisma db push, prisma migrate reset, db:seed.
# Устаревший rsync-деплой из локальной папки — DEPRECATED-DO-NOT-USE-deploy-fast.sh, НЕ использовать.

set -euo pipefail

# Скрипт обновляет САМ СЕБЯ: `git reset --hard` ниже переписывает этот файл. Bash читает
# сценарий не целиком, а по мере выполнения, запоминая смещение в файле, — и после подмены
# продолжил бы читать НОВЫЙ файл со СТАРОГО смещения, то есть с середины чужой строки.
# Поэтому сразу перезапускаемся с неизменяемой копии.
SELF_COPY="/tmp/floremart-deploy-running.sh"
if [[ "${FLOREMART_DEPLOY_REEXEC:-}" != "1" ]]; then
  cp -f "$0" "$SELF_COPY"
  FLOREMART_DEPLOY_REEXEC=1 exec bash "$SELF_COPY" "$@"
fi

FIRST_RUN=false
FORCE_REINSTALL=false
for arg in "$@"; do
  case "$arg" in
    --first-run) FIRST_RUN=true ;;
    --reinstall) FORCE_REINSTALL=true ;;
  esac
done

if [[ ! -f ".env" ]]; then
  echo "Ошибка: .env не найден в $(pwd)." >&2
  exit 1
fi

SITE_URL="https://floremart.com"
BUILD_DIR=".next.build"
LIVE_DIR=".next"
PREV_DIR=".next.previous"
FAILED_DIR=".next.failed"

# Флаг обслуживания для nginx. Лежит ВНЕ каталога сайта: nginx работает от пользователя clp,
# а каталог сайта — 770 floremart:floremart, внутрь он не видит вовсе.
MAINT_FLAG="${FLOREMART_MAINT_FLAG:-/tmp/floremart-maintenance}"

maint_on()  { : > "$MAINT_FLAG" 2>/dev/null || true; }
maint_off() { rm -f "$MAINT_FLAG" 2>/dev/null || true; }

# Флаг снимается ВСЕГДА: при успехе, ошибке, откате и Ctrl-C. Забытый флаг оставил бы сайт
# под заглушкой при живом приложении — это хуже самой ошибки.
trap maint_off EXIT INT TERM

# Печатает последний HTTP-код в stdout; возвращает 0, только если дождались 200.
health() {
  local code=""
  for i in 1 2 3 4 5; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE_URL" || true)
    echo "  попытка $i: HTTP $code" >&2
    if [[ "$code" == "200" ]]; then echo "$code"; return 0; fi
    sleep 3
  done
  echo "$code"
  return 1
}

reload_apps() {
  if [[ "$FIRST_RUN" == "true" ]]; then
    pm2 start ecosystem.config.js
    pm2 start ecosystem.worker.config.js
    pm2 save
  else
    pm2 reload ecosystem.config.js
    pm2 reload ecosystem.worker.config.js
  fi
}

PREV_SHA=$(git rev-parse HEAD)

echo "==> Получаем изменения из GitHub (main)"
git fetch origin main
git reset --hard origin/main

# npm ci сносит node_modules целиком, а работающий сервер часть пакетов подгружает на лету.
# Не менялся lock — переустанавливать нечего, и трогать зависимости под живым сайтом незачем.
# Принудительно: ./deploy.sh --reinstall
echo "==> Зависимости"
if [[ "$FIRST_RUN" == "true" || "$FORCE_REINSTALL" == "true" || ! -d node_modules ]]; then
  echo "  npm ci (полная установка)"
  npm ci
elif git diff --quiet "$PREV_SHA" HEAD -- package.json package-lock.json; then
  echo "  package.json / package-lock.json не менялись — npm ci пропускаем"
else
  echo "  зависимости изменились — npm ci"
  npm ci
fi

echo "==> Генерируем Prisma Client"
npx prisma generate

echo "==> Применяем миграции БД (prisma migrate deploy)"
npx prisma migrate deploy

# ─────────────────────────────────────────────────────────────────────────────
# Сборка В СТОРОНЕ. Сайт всё это время работает на текущем .next и ничего не замечает.
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Собираем production-билд в $BUILD_DIR (сайт продолжает работать)"
rm -rf "$BUILD_DIR"
if ! NEXT_DIST_DIR="$BUILD_DIR" npm run build; then
  rm -rf "$BUILD_DIR"
  echo "!!! BUILD FAILED — боевая сборка не тронута, PM2 не трогаю, сайт работает" >&2
  exit 4
fi

mkdir -p logs

# ─────────────────────────────────────────────────────────────────────────────
# Короткое окно: секунды. Только здесь показываем заглушку.
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Подмена сборки и рестарт (окно обслуживания)"
maint_on

rm -rf "$FAILED_DIR" "$PREV_DIR"
[[ -e "$LIVE_DIR" ]] && mv "$LIVE_DIR" "$PREV_DIR"
mv "$BUILD_DIR" "$LIVE_DIR"

reload_apps

echo "==> Health-check"
if code=$(health); then
  maint_off
  curl -s --max-time 15 "$SITE_URL/api/health" || true; echo
  pm2 status
  # Предыдущая сборка НЕ удаляется: это готовый откат до следующего деплоя.
  echo "✅ Деплой завершён: $SITE_URL = 200 (откат доступен: $PREV_DIR)"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Откат: новая сборка поднялась, но сайт не отвечает.
# ─────────────────────────────────────────────────────────────────────────────
echo "!!! Health-check не прошёл (HTTP $code) — возвращаю предыдущую сборку" >&2
if [[ ! -e "$PREV_DIR" ]]; then
  echo "!!! Откатывать не на что: $PREV_DIR отсутствует. Нужен ручной разбор." >&2
  exit 5
fi

rm -rf "$FAILED_DIR"
mv "$LIVE_DIR" "$FAILED_DIR"
mv "$PREV_DIR" "$LIVE_DIR"
reload_apps

if rb=$(health); then
  maint_off
  echo "↩️  Откат выполнен: сайт работает на предыдущей сборке (HTTP $rb)." >&2
  echo "    Неудачная сборка сохранена в $FAILED_DIR для разбора." >&2
  exit 6
fi

echo "!!! Откат не помог (HTTP $rb) — нужен ручной разбор." >&2
exit 7
