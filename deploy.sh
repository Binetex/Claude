#!/usr/bin/env bash
# ЕДИНЫЙ деплой floremart.com (git-based, CloudPanel-сервер).
# Запускать ИЗ директории сайта (где лежит этот файл), под пользователем сайта.
#
# Поток: git fetch origin main → git reset --hard origin/main → npm ci → prisma generate →
#        prisma migrate deploy → build (с откатом .next.previous) → reload app+worker → health.
#
#   ./deploy.sh              — обычное обновление (reload без даунтайма)
#   ./deploy.sh --first-run  — первый запуск (pm2 start вместо reload)
#
# НИКОГДА не выполняет: prisma db push, prisma migrate reset, db:seed.
# Устаревший rsync-деплой из локальной папки — DEPRECATED-DO-NOT-USE-deploy-fast.sh, НЕ использовать.

set -euo pipefail

FIRST_RUN=false
[[ "${1:-}" == "--first-run" ]] && FIRST_RUN=true

if [[ ! -f ".env" ]]; then
  echo "Ошибка: .env не найден в $(pwd)." >&2
  exit 1
fi

SITE_URL="https://floremart.com"

echo "==> Получаем изменения из GitHub (main)"
git fetch origin main
git reset --hard origin/main

echo "==> Устанавливаем зависимости (npm ci)"
npm ci

echo "==> Генерируем Prisma Client"
npx prisma generate

echo "==> Применяем миграции БД (prisma migrate deploy)"
npx prisma migrate deploy

echo "==> Собираем production-билд (с откатом .next.previous при сбое)"
rm -rf .next.previous
[[ -e .next ]] && mv .next .next.previous || true
if npm run build; then
  rm -rf .next.previous
else
  echo "!!! BUILD FAILED — откат .next, PM2 не трогаю" >&2
  rm -rf .next
  [[ -e .next.previous ]] && mv .next.previous .next
  exit 4
fi

mkdir -p logs

if [[ "$FIRST_RUN" == "true" ]]; then
  echo "==> Первый запуск: pm2 start (app + worker)"
  pm2 start ecosystem.config.js
  pm2 start ecosystem.worker.config.js
  pm2 save
else
  echo "==> Обновление: pm2 reload (app + worker)"
  pm2 reload ecosystem.config.js
  pm2 reload ecosystem.worker.config.js
fi

echo "==> Health-check"
code=""
for i in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE_URL" || true)
  echo "  попытка $i: HTTP $code"; [[ "$code" == "200" ]] && break; sleep 3
done
curl -s --max-time 15 "$SITE_URL/api/health" || true; echo
pm2 status
[[ "$code" == "200" ]] || { echo "⚠️ последний HTTP код: $code" >&2; exit 5; }
echo "✅ Деплой завершён: $SITE_URL = 200"
