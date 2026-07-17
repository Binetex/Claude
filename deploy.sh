#!/usr/bin/env bash
# Деплой / обновление floremart.com на CloudPanel-сервере.
# Запускать ИЗ директории сайта (где лежит этот файл), под пользователем сайта.
#
# Использование:
#   ./deploy.sh              — обычное обновление (git pull + migrate + build + reload)
#   ./deploy.sh --first-run  — первый деплой (то же самое + pm2 start вместо reload)
#
# Скрипт НИКОГДА не выполняет: prisma db push, prisma migrate reset, db:seed.

set -euo pipefail

FIRST_RUN=false
if [[ "${1:-}" == "--first-run" ]]; then
  FIRST_RUN=true
fi

if [[ ! -f ".env" ]]; then
  echo "Ошибка: .env не найден в $(pwd). Скопируйте .env.production.example в .env и заполните значения." >&2
  exit 1
fi

echo "==> Получаем изменения из GitHub (main)"
git fetch origin main
git reset --hard origin/main

echo "==> Устанавливаем зависимости (npm ci)"
npm ci

echo "==> Применяем миграции БД (prisma migrate deploy)"
npx prisma migrate deploy

echo "==> Собираем production-билд"
rm -rf .next
npm run build

mkdir -p logs

if [[ "$FIRST_RUN" == "true" ]]; then
  echo "==> Первый запуск: pm2 start"
  pm2 start ecosystem.config.js
  pm2 save
else
  echo "==> Обновление: pm2 reload (без даунтайма)"
  pm2 reload ecosystem.config.js
fi

echo "==> Готово. Статус процесса:"
pm2 status floremart
