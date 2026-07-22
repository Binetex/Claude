# Floremart — единый дашборд управления заказами

Next.js-приложение для управления заказами нескольких флористических интернет-магазинов
(WooCommerce, Shopify) в одном дашборде с ролями владельца, флориста и колл-центра.

Полное описание архитектуры, ролей, модели данных и бизнес-правил — в [CLAUDE.md](./CLAUDE.md).
Инструкция по production-деплою на CloudPanel/PM2 — в [DEPLOY.md](./DEPLOY.md).

## Быстрый старт (разработка)

Требуется Node.js ≥ 20.9 (`nvm use` подхватит версию из `.nvmrc`).

```bash
npm install                 # зависимости + автогенерация клиента Prisma
cp .env.example .env        # заполнить DATABASE_URL и AUTH_SECRET
npm run db:migrate          # применить миграции к БД
npm run db:seed             # тестовые данные для локальной разработки (НЕ для prod)
npm run dev                 # http://localhost:3000
```

Демо-доступы после `db:seed` (пароль `password123`): `owner@demo.local`, `cc@demo.local`,
`florist1@demo.local`, `florist2@demo.local`.

## Архитектура маршрутов

- `/` — публичный лендинг.
- `/login` — авторизация.
- `/dashboard/*` — закрытая панель (владелец, флорист, колл-центр — единое приложение,
  роль определяет доступный раздел).
- `/api/health` — health-check для мониторинга/Nginx.
- `/api/webhooks/[platform]` — приём вебхуков интеграций (пока каркас).

## Полезные команды

См. полный список в [ARCHITECTURE.md, раздел «Команды»](./docs/ARCHITECTURE.md#14-команды).
Production-деплой и работа с сервером — в [DEPLOY.md](./DEPLOY.md).
