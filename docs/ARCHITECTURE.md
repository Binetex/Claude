# Floremart — архитектура

> Общая архитектура, модель данных и бизнес-правила. Для Shopify/WooCommerce — см.
> [integrations/shopify.md](./integrations/shopify.md). Для деплоя — см. [../DEPLOY.md](../DEPLOY.md).
> Для текущего состояния проекта и оставшейся работы — см. [HANDOFF.md](./HANDOFF.md) и [../TODO.md](../TODO.md).

## 1. Назначение системы

Единый веб-дашборд для управления заказами нескольких флористических интернет-магазинов
(WordPress/WooCommerce и Shopify). Все новые заказы с подключённых сайтов попадают в общий
дашборд; изменения (дата доставки, статус и др.) передаются обратно на исходный сайт.
Система рассчитана на добавление новых магазинов без переделки.

Три роли: **владелец**, **флорист**, **специалист колл-центра**. Заказы автоматически
распределяются между флористами по приоритету, привязанному к сайту.

## 2. Текущий стек

- **TypeScript**, **Next.js 16** (App Router, Turbopack, React 19) — интерфейс и серверная часть
- **PostgreSQL** (в разработке — Neon) + **Prisma 7** (driver adapter `@prisma/adapter-pg`)
- **Tailwind CSS v4** (UI-компоненты hand-rolled в стиле shadcn)
- Авторизация — собственная: JWT в httpOnly-cookie (`jose`) + `bcryptjs`
- `date-fns`, `zod`, `lucide-react`, `clsx`/`tailwind-merge`

**Этап 1 — сознательные упрощения за интерфейсами** (заменяются без переделки бизнес-логики):
- Очередь фоновых задач (`src/lib/jobs.ts`) — ин-мемори; интерфейс совместим с BullMQ
- Хранилище фото (`src/lib/storage.ts`) — локальный диск; интерфейс `ImageStorage` под S3
- Адаптеры Shopify / WooCommerce / Quo / Burq / Telegram — заглушки за интерфейсами,
  каждый читает свой feature-флаг из `src/lib/featureFlags.ts`
  (`SHOPIFY_ENABLED`, `WOOCOMMERCE_ENABLED`, `QUO_ENABLED`, `BURQ_ENABLED`, `EMAIL_ENABLED`,
  `TELEGRAM_ENABLED` — все `false` до тех пор, пока интеграция не подключена по-настоящему)

## 3. Архитектурный подход

**Модульный монолит** (не микросервисы). Одно Next.js-приложение, разделённое на модули.
Внешние системы изолированы адаптерами и НЕ смешиваются с бизнес-логикой. Внутренняя БД —
первоисточник; сайты-источники не являются основной базой.

Никакой привязки к Vercel/serverless: обычный `next build` + `next start` под Node.js/PM2.
Файловое хранилище фото и ин-мемори очередь предполагают один сервер (для масштабирования —
переключить адаптеры на S3 и BullMQ/Redis).

## 4. Структура модулей

Маршруты: `/` — публичный лендинг (НЕ гейтится авторизацией), `/login` — вход,
**всё внутреннее приложение живёт под `/dashboard/*`** — единое Next.js-приложение,
без отдельного поддомена/приложения для панели (см. п.5 про пути по ролям).

```
src/
  app/
    page.tsx                   — "/" публичный лендинг Floremart
    login/                     — "/login" (+ LoginForm client)
    actions/auth.ts            — server actions: login/logout
    dashboard/
      (owner)/                 — "/dashboard*" для владельца (layout: requireRole OWNER)
        page.tsx                 "/dashboard"
        orders/, orders/[id]/, sites/, products/, florists/, users/
        actions.ts              — server actions владельца
      (florist)/                — "/dashboard/f*" (layout: requireFlorist)
        f/, f/[id]/, actions.ts
      (callcenter)/              — "/dashboard/cc*" (layout: requireRole CALL_CENTER)
        cc/, cc/[id]/, actions.ts
    api/
      health/route.ts           — "/api/health" (без авторизации, для Nginx/PM2/мониторинга)
      webhooks/[platform]/      — приём вебхуков (Shopify — реально, WooCommerce — каркас)
      integrations/shopify/oauth/callback/ — OAuth-колбэк подключения магазина
  lib/
    db.ts        — Prisma client (singleton, driver adapter)
    auth.ts      — сессии, getCurrentUser, verifyCredentials
    rbac.ts      — requireUser/requireRole/requireFlorist, homePathFor
    featureFlags.ts — чтение SHOPIFY_ENABLED и т.п. из env
    appUrl.ts    — публичный базовый URL (для redirect_uri OAuth)
    statuses.ts  — подписи и цвета статусов (RU)
    money.ts, format.ts, cn.ts, jobs.ts, storage.ts
  modules/
    orders/      — serialize.ts (ролевые DTO), queries.ts (ролевые запросы), metrics.ts
    assignments/ — service.ts (назначение/принятие/отказ/переназначение)
    pricing/     — service.ts (расчёт и снимок цены флориста, прибыль)
  integrations/
    shopify/     — oauth.ts, webhookAuth.ts, ingestOrder.ts, adapter.ts (см. integrations/shopify.md)
    woocommerce/ messaging(quo)/ delivery(burq)/ notifications(telegram) — заглушки
  generated/prisma/ — сгенерированный клиент Prisma (НЕ в git — генерируется `prisma generate`,
                       автоматически при `npm install` через `postinstall`)
prisma/          — schema.prisma, seed.ts (dev-only!), migrations/
scripts/create-owner.ts — безопасное создание первого владельца (см. п.13)
ecosystem.config.js, deploy.sh — production-запуск через PM2 (см. ../DEPLOY.md)
vitest.config.ts, vitest.setup.ts, vitest.server-only-stub.ts — конфиг тестов

../floremart-shopify-app/ — ОТДЕЛЬНЫЙ проект рядом с этим репо (не внутри него): Shopify CLI
  конфиг приложения (shopify.app.toml), управляется через `shopify app deploy`, к нашему
  Next.js-коду отношения не имеет, кроме того что redirect_uri/webhook uri в нём указывают на
  floremart.com.
```

## 5. Роли и права доступа

Проверка — только на сервере (`src/lib/rbac.ts`). Каждый раздел защищён в `layout.tsx`;
каждое серверное действие повторно проверяет роль.

- **Владелец (OWNER)** — полный доступ: все заказы, реальные суммы, налоги/чаевые/скидки/доставка,
  цена каждого флориста, прибыль, управление сайтами/товарами/ценами/пользователями/распределением.
- **Флорист (FLORIST)** — только назначенные ему заказы и только своя цена изготовления.
  Не видит (НИКОГДА, независимо от настроек ниже): прибыль владельца, фактическую себестоимость
  доставки, цены/заказы других флористов, чужие заказы по прямой ссылке (404).
  Дополнительно управляется полем `Florist.financeVisibility` (владелец переключает на `/dashboard/florists`):
    - `MAKER_ONLY` (по умолчанию) — видит только свою цену изготовления (как в исходном ТЗ).
    - `FULL` — дополнительно видит налог/доставку клиенту/чаевые/скидку/итог клиента по СВОИМ
      заказам (см. п.6). Введено по отдельному запросу владельца поверх исходного ТЗ.
- **Колл-центр (CALL_CENTER)** — все заказы и все данные для общения с клиентом,
  но НИКАКИХ финансов (ни сумм клиента, ни цен флористов).

Домашние страницы (`homePathFor` в `rbac.ts`): OWNER→`/dashboard`, FLORIST→`/dashboard/f`,
CALL_CENTER→`/dashboard/cc`. Неавторизованный доступ к любому `/dashboard/*` → редирект на
`/login`; доступ не той ролью → редирект на свою домашнюю страницу (не 403-страница с текстом).

## 6. Правила скрытия финансовых данных

**Защита на источнике, а не в вёрстке.** Данные заказа отдаются через ролевые сериализаторы
(`src/modules/orders/serialize.ts`):

- `serializeForOwner` — все поля, включая объект `finance` и `externalPrice`/`floristItemPrice`.
- `serializeForCallCenter` — без `finance`, без цен в позициях.
- `serializeForFlorist` — всегда `floristTotal`/`floristItemPrice`; объект `finance`
  (`itemsTotal, tax, tip, discount, deliveryCustomerCost, customerTotal`) добавляется в ответ,
  только если `currentFlorist.financeVisibility === "FULL"` — иначе ключа `finance` в объекте
  нет вообще (проверено: у MAKER_ONLY-флориста `"finance" in order` === false для 100% заказов).
  `estimatedProfit`, `deliveryActualCost` и цены других флористов не попадают в DTO флориста
  ни при каком значении `financeVisibility`.

Ролевые запросы (`queries.ts`): владелец/колл-центр — `listForOwner`/`listForCallCenter`;
флорист — `listForFlorist(floristId)` и `getForFlorist(id, floristId)`, жёстко фильтруются по
`currentFloristId`. Прямой запрос чужого заказа флористом → `null` → 404.

**Цены товаров под флориста** (`FloristProductPrice`) редактируются владельцем на
`/dashboard/products` (инлайн, привязаны к оригинальному товару — `listPrice` виден только
владельцу в той же таблице). Изменение прайса не затрагивает уже размещённые заказы (см. п.10, снимок).

## 7. Модель заказов

Заказ (`Order`) хранит внутренний `id`, внешний `externalId`, `siteId`, `platform`, состояние
синхронизации. Позиции — `OrderItem` (снимок названия/картинки, `quantity`, `options`,
`externalPrice` = цена клиенту, `floristItemPrice` = снимок цены флориста).
История назначений — `OrderAssignment`. Сообщения — `Message` (тестовые на этапе 1).
Доставка хранится полями заказа (`deliveryStatus`, `trackingUrl`, `deliveryActualCost`,
`deliveryPhotoUrl`). Старые заказы не импортируются автоматически (см.
[integrations/shopify.md](./integrations/shopify.md) про разовый backfill-скрипт); дубли не
ищутся; карточка клиента не строится.

Финансовые поля — **раздельные**: `itemsTotal, tax, tip, discount, deliveryCustomerCost,
customerTotal, floristTotal, deliveryActualCost, estimatedProfit`.

## 8. Разделение статусов

Пять независимых полей (не единый `status`):

- `paymentStatus` — UNPAID / PAID / REFUNDED
- `orderStatus` — AWAITING_PAYMENT, CONFIRMED, ASSIGNED, FLORIST_ACCEPTED, IN_PROGRESS, READY,
  AWAITING_COURIER, IN_TRANSIT, DELIVERED, PROBLEM, CANCELLED
- `assignmentStatus` — UNASSIGNED / ASSIGNED / ACCEPTED
- `deliveryStatus` — PENDING / SCHEDULED / IN_TRANSIT / DELIVERED / FAILED
- `syncStatus` — LOCAL / SYNCED / PENDING / ERROR

«Новый» не используется — оплаченный заказ сразу CONFIRMED. Отказ флориста — не статус заказа,
а действие (`OrderAssignment.state = DECLINED`); после передачи заказ снова ASSIGNED.

## 9. Логика назначения и переназначения (`src/modules/assignments/service.ts`)

Приоритеты флористов — на сайт (`SiteFloristPriority`, упорядоченный список; position 0 = основной).

- `assignInitial(orderId)` — назначает основному флористу сайта; авто-снимок цены; статус ASSIGNED.
  **Идемпотентно**: если у заказа уже есть назначение — ничего не делает.
- `acceptOrder` — ASSIGNED → ACCEPTED, orderStatus FLORIST_ACCEPTED.
- `declineOrder` — фиксирует отказ (DECLINED), исключает флориста из повторного назначения ЭТОГО
  заказа, передаёт следующему по приоритету с пересчётом цены. Если следующих нет → UNASSIGNED
  (по кругу не гоняет).
- `reassignManual(orderId, floristId, keepManualPrice)` — ручное переназначение владельцем;
  при ручной цене — выбор «оставить ручную» или «взять авто-цену нового флориста».
- `startWork`, `markReady`, `setReadyAt` — процесс флориста; все действия проверяют,
  что флорист является текущим исполнителем.

Уведомление флориста — `notifyFloristAssigned` (Telegram-стаб через очередь).

## 10. Логика цен флористов (`src/modules/pricing/service.ts`)

- **Авто**: цена берётся из `FloristProductPrice` (товар × флорист), суммируется по позициям.
- **Ручная** (`priceMode = MANUAL`): владелец задаёт сумму на заказ, приоритетнее авто.
- **Снимок при назначении**: `floristTotal` (заказ) и `floristItemPrice` (позиции) фиксируются
  в момент назначения — последующее изменение прайс-листа НЕ меняет старые заказы.
- Прибыль владельца: `estimatedProfit = itemsTotal − floristTotal − deliveryActualCost`.
- История изменения цен не хранится. Выплаты/задолженности не считаются.

## 11. Правила фоновых задач (`src/lib/jobs.ts`)

- Единая точка постановки задач `enqueue(name, payload)`.
- Этап 1 — исполнение инлайн (лог). Этап 2 — BullMQ/Redis за той же сигнатурой.
- Через задачи идут: уведомления флористу (Telegram), обратная синхронизация, SMS/email.
  Вебхук ставит задачу и сразу отвечает.

## 12. Правила хранения фотографий (`src/lib/storage.ts`)

- Фото НЕ хранятся в БД. В БД — только ссылки (`bouquetPhotoUrl`, `deliveryPhotoUrl`) и метаданные.
- Этап 1 — локальный диск `public/uploads` через интерфейс `ImageStorage`.
- Этап 2 — S3-совместимый адаптер за тем же интерфейсом (замена реализации без правки вызовов).
- Флорист загружает фото букета (выбор файла/камера, предпросмотр, замена до сохранения). Фото не
  обязательно для статуса «Готов».

## 13. Production-инфраструктура

Деплой — CloudPanel (Nginx reverse proxy + Let's Encrypt) + PM2 на VPS, без Vercel/serverless.
Полная инструкция, команды первого деплоя/обновления/отката/бэкапа — в [../DEPLOY.md](../DEPLOY.md).
Здесь — только то, что должен знать разработчик:

- **Health-check**: `GET /api/health` — без авторизации, проверяет БД (`SELECT 1`), отдаёт
  `{"status":"ok","db":"ok"}` или 503. Используется PM2/Nginx/внешним мониторингом.
- **Первый владелец**: `npm run create-owner` (`scripts/create-owner.ts`) — интерактивный
  CLI с маскированным вводом пароля; отказывает, если OWNER уже существует (нужен `--force`
  для сознательного повторного создания). НЕ HTTP-эндпоинт — только локальный запуск на сервере.
  Пароль передавать только через переменную окружения `OWNER_PASSWORD` или интерактивный ввод,
  никогда через аргумент командной строки в неинтерактивном режиме (попадает в shell-историю).
- **Feature-флаги интеграций** читаются в `src/lib/featureFlags.ts` из env
  (`SHOPIFY_ENABLED`, `WOOCOMMERCE_ENABLED`, `QUO_ENABLED`, `BURQ_ENABLED`, `EMAIL_ENABLED`,
  `TELEGRAM_ENABLED`) — включать только когда интеграция реализована и сознательно включена.
  `SHOPIFY_ENABLED` уже реально используется — при `false` вебхук отвечает 503, не пишет в БД.
- **Shopify**: `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` — credentials приложения "Floremart
  Sync" из Shopify Dev Dashboard, одни на все подключаемые магазины (см.
  [integrations/shopify.md](./integrations/shopify.md)). `APP_URL`
  (по умолчанию `https://floremart.com`) должен побайтово совпадать с `redirect_uri`,
  зарегистрированным в `../floremart-shopify-app/shopify.app.toml`.
- **Только Prisma Migrations** в production: `prisma migrate deploy`. Никогда `prisma db push`
  или `prisma migrate reset` — необратимо и не подходит для боевых данных.
- **Тестовые данные — только для разработки**: `npm run db:seed` не должен запускаться
  в production (`deploy.sh` его не вызывает и не должен начать).
- **Secure cookies**: `src/lib/auth.ts` всегда ставит `Secure` на cookie сессии в
  `NODE_ENV=production`, независимо от того, что Next.js видит на внутреннем hop между Nginx
  и `next start` (это нормально — браузер общается только с Nginx по HTTPS).

## 14. Команды

Требуется **Node.js ≥ 20.9** (проект разрабатывается на Node 24 — `nvm use 24`).
Переменные: `DATABASE_URL`, `AUTH_SECRET` в `.env`.

```bash
npm install          # зависимости (postinstall сам вызовет prisma generate)
npm run db:generate  # сгенерировать клиент Prisma вручную
npm run db:migrate   # применить миграции (dev, интерактивно)
npm run db:deploy    # применить миграции (prod, неинтерактивно)
npm run db:seed      # залить тестовые данные (18 сценариев)
npm run db:studio    # Prisma Studio (просмотр БД)
npm run create-owner # создать первого владельца (только вручную, см. п.13)
npm run dev          # dev-сервер (http://localhost:3000)
npm run build        # production-сборка
npm start            # production-запуск (для PM2, требует AUTH_SECRET)
npm run typecheck    # проверка типов (tsc --noEmit)
npm run lint         # ESLint
npm test             # тесты (vitest, интеграционные — пишут/чистят свою БД)
```

Демо-доступы (пароль `password123`): `owner@demo.local`, `cc@demo.local`,
`florist1@demo.local`, `florist2@demo.local`.

> Не запускать `next build` в ту же `.next`, пока идёт `next dev` — возможен повреждённый
> dev-манифест. Лечится `rm -rf .next` и перезапуском.

## 15. Запрещённые / опасные действия

- Не хранить фото и секреты в БД; не хранить заказы в JSON-файлах.
- Не привязываться к Vercel/serverless, Kubernetes, Firebase/MongoDB как основной базе.
- Не смешивать код адаптеров с бизнес-логикой.
- Не отдавать колл-центру финансовые данные ни в каком виде (в т.ч. через новые поля/эндпоинты).
- Флористу — не отдавать `estimatedProfit`, `deliveryActualCost` и цены/заказы других флористов
  ни при каком значении `financeVisibility` (только `tax/tip/discount/deliveryCustomerCost/
  customerTotal` по СВОИМ заказам допустимы, и только в режиме FULL — см. п.5–6).
- Не пересчитывать цену старых заказов при изменении прайса (снимок неизменен).
- Не коммитить `.env`, `public/uploads`, реальные токены/строки подключения.
- Не удалять/не перезаписывать данные без явного запроса; деструктивные git-операции — с осторожностью.
- В production — никогда `prisma db push`/`prisma migrate reset`, никогда `db:seed`.
- Не менять глобальную конфигурацию сервера (Nginx/PHP/CloudPanel/systemd) и чужие
  Virtual Host'ы/сайты/PM2-процессы/сертификаты без явного отдельного подтверждения — см. ../DEPLOY.md.
- Правило про `cardMessage`/`customerNote` при синхронизации с Shopify — см.
  [integrations/shopify.md](./integrations/shopify.md).

## 16. Порядок дальнейшей разработки

1. (Готово, этап 1) Ядро: авторизация, роли, сайты, товары, цены (в т.ч. редактируемые прайсы
   флористов и переключатель `financeVisibility`), заказы, распределение, UI ролей, интеграционные
   тесты ядра назначения.
2. (Готово) Shopify: OAuth-подключение магазина, приём и идемпотентный маппинг заказов через
   вебхуки, авто-назначение флориста. Не сделано: `pushUpdate` (обратная запись изменений в
   Shopify), периодический добор пропущенных заказов, реальная фоновая очередь вместо синхронной
   обработки в вебхуке (см. [integrations/shopify.md](./integrations/shopify.md)).
3. WooCommerce (вебхуки + идемпотентность + обратная запись) — каркас есть, не реализовано.
4. BullMQ/Redis вместо ин-мемори очереди/синхронной обработки; периодический добор пропущенных заказов.
5. Telegram-уведомления флористам (приём принятия/отказа).
6. Quo (SMS/email) и Burq (доставка).
7. S3-совместимое хранилище фото.
8. Остальные управляющие формы админ-разделов (создание/редактирование приоритетов
   флористов по сайту, пользователей) — сейчас в режиме просмотра; сайты (включая Shopify-
   подключение), цены товаров и видимость финансов флориста уже редактируемы.

Внешние API не подключать одновременно; сначала стабилизировать уже подключённое.
