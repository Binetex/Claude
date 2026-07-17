# Floremart — единый дашборд управления заказами

> Домен: floremart.com. Документ для разработчиков и AI-ассистентов. Отражает состояние
> **этапа 1** (рабочее ядро без реальных внешних интеграций) + production-инфраструктуру.
> Деплой — см. [DEPLOY.md](./DEPLOY.md).

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
    shopify/     — oauth.ts, webhookAuth.ts, ingestOrder.ts, adapter.ts (см. п.11)
    woocommerce/ messaging(quo)/ delivery(burq)/ notifications(telegram) — заглушки
  generated/prisma/ — сгенерированный клиент Prisma (НЕ в git — генерируется `prisma generate`,
                       автоматически при `npm install` через `postinstall`)
prisma/          — schema.prisma, seed.ts (dev-only!), migrations/
scripts/create-owner.ts — безопасное создание первого владельца (см. п.15)
ecosystem.config.js, deploy.sh — production-запуск через PM2 (см. DEPLOY.md)
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
`deliveryPhotoUrl`). Старые заказы не импортируются; дубли не ищутся; карточка клиента не строится.

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

## 11. Синхронизация Shopify (реализовано) и WooCommerce (каркас)

Внутренняя БД — первоисточник. Каждый заказ хранит `externalId`, `platform`, `syncStatus`,
`lastSyncedAt`. Новые заказы приходят вебхуком сразу после подключения сайта; для загрузки
истории по уже подключённому магазину есть отдельный разовый скрипт
`scripts/backfill-shopify-orders.ts` (см. `Order.isBackfilled`) — обычный импорт истории
при подключении по-прежнему не делается автоматически.

### Shopify — реальная интеграция

**Приложение**: "Floremart Sync" в Shopify Dev Dashboard (Custom Distribution — устанавливается
в конкретные магазины, не публикуется). Конфиг — `../floremart-shopify-app/shopify.app.toml`
(отдельный проект рядом с этим репо, управляется через `shopify app deploy`, НЕ часть Next.js-кода).
`embedded = false` — у приложения нет своего UI внутри Shopify, только API+вебхуки.

**Подключение магазина владельцем** (`/dashboard/sites` → «Подключить Shopify»):
1. Owner вводит домен → `ownerConnectShopify` (`src/app/dashboard/(owner)/actions.ts`) строит
   подписанный `state` (`src/integrations/shopify/oauth.ts`) и редиректит на Shopify authorize URL.
2. После согласия в магазине Shopify редиректит на
   `/api/integrations/shopify/oauth/callback` — там проверяется HMAC query-параметров и `state`,
   `code` меняется на постоянный `access_token`, создаётся/обновляется `Site`
   (`shopifyShopDomain`, `shopifyAccessToken`).
3. `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` — одни на все магазины (это credentials
   приложения, не конкретного магазина); per-магазин `access_token` хранится в `Site`.

**Приём заказов** (`/api/webhooks/[platform]`, `platform=shopify`):
- Подписки на вебхуки (`orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled`)
  декларация в `shopify.app.toml` их **не регистрирует** — проверено вживую (после install
  `webhookSubscriptions` был пуст). Регистрируются явно через GraphQL-мутацию
  `webhookSubscriptionCreate` в OAuth callback (`src/integrations/shopify/webhooks.ts`,
  `registerOrderWebhooks`), идемпотентно (пропускает уже подписанные темы).
- Подпись проверяется по **сырому телу** запроса (`X-Shopify-Hmac-Sha256`,
  `src/integrations/shopify/webhookAuth.ts`) до `JSON.parse` — невалидная подпись → 401.
- Маппинг → `src/integrations/shopify/ingestOrder.ts` (`ingestShopifyOrder`):
  **открытка (`cardMessage`) читается из стандартного поля заказа Shopify `note`** (см.
  `extractAddressAndCardMessage`) — у этого магазина (O'hara Florist) отдельного
  note_attribute под открытку тема не использует, клиенты всегда пишут её в обычное поле
  заказа. `customerNote` для Shopify-заказов **не заполняется автоматически** — это чисто
  ручное поле владельца/колл-центра. Дата доставки/окно доставки по-прежнему читаются из
  `note_attributes` (эвристика по имени атрибута — `/delivery.*date/i`,
  `/delivery.*(time|window)/i`; если тема магазина называет поля иначе, эвристику нужно
  поправить под конкретный магазин). Позиции сопоставляются с нашими `Product` по
  `externalId` (variant_id/product_id) — если владелец не завёл соответствующий `Product`,
  авто-цена флориста будет 0 до тех пор, пока он не заведёт товар или не проставит ручную
  цену на заказ.
- **Идемпотентность**: ищем существующий `Order` по `(siteId, externalId)`. Повторный
  `orders/create`/`orders/updated` не создаёт дубль; обновляются `paymentStatus`,
  **адрес получателя и `cardMessage`** (см. п.12 — они действительно двусторонние поля
  Shopify, оба через `note`/`shipping_address`) и вызывается `assignInitial()`, если заказ
  только что стал оплаченным. `customerNote`/`deliveryDate`/`deliveryWindow`
  **не перезаписываются** — `customerNote` не Shopify-поле вообще (ручное), а
  `deliveryDate`/`deliveryWindow` парсятся из `note_attributes`, которое Shopify не
  позволяет менять после создания заказа.
- **Обработка синхронная в самом вебхуке** (не через `enqueue()`/фоновую очередь) — сознательное
  отступление от изначального плана «вебхук только принимает, тяжёлая работа в фоне»: `jobs.ts`
  на этом этапе — просто логгер, реальной очереди нет, поэтому запись в БД происходит прямо в
  обработчике. Это безопасно при текущем объёме (несколько Prisma-запросов укладываются в
  секунды, у Shopify таймаут вебхука — единицы секунд с ретраями), но при росте нагрузки нужно
  перевести на BullMQ (см. п.13) и вернуться к исходному плану.
- Ошибка маппинга логируется (`console.error`), но эндпоинт всё равно отвечает 200 — иначе
  Shopify будет бесконечно ретраить вебхук с тем же багом. Разбор — по логам PM2.

**Обратная запись** (`src/integrations/shopify/pushUpdate.ts`, `syncOrderToShopify`) —
реализована частично: адрес получателя (`shipping_address`) и открытка (`cardMessage`,
через стандартное поле заказа Shopify `note`) уходят обратно при
`ownerUpdateContacts`/`ownerUpdateCardAndNote` (`src/app/dashboard/(owner)/actions.ts`).
Если Shopify отклоняет обновление адреса (заказ уже fulfilled/locked) — молча
логируется, владельцу не показывается (осознанный выбор). Дата/интервал доставки
**обратно не пишутся** — они у нас парсятся из `note_attributes`, а это поле Shopify не
даёт менять через Admin API после создания заказа; писать их в другое поле означало бы не
то же самое поле, которое читает pull, и правки владельца тут же затирались бы обратно на
оригинал следующим же `orders/updated` (который наш собственный push и спровоцирует). Это
жёсткое ограничение платформы, не техдолг — не пытаться обойти без отдельного анализа
(например, через Shopify order metafields, которые не видны в стандартном UI заказа без
кастомного UI-расширения). `customerNote` тоже не синхронизируется — это ручное поле
владельца/колл-центра, у Shopify нет для него отдельного назначенного поля (см. п.12).

### WooCommerce — каркас, не реализовано

Адаптер (`src/integrations/woocommerce/adapter.ts`) — заглушка за флагом `WOOCOMMERCE_ENABLED`.

## 12. Правила работы с cardMessage и customerNote

- Хранятся раздельно: `cardMessage` / `customerNote`, плюс оригиналы `originalCardMessage` /
  `originalCustomerNote` (снимок значения на момент создания заказа, никогда не меняются).
- **Не смешивать** открытку и заметку.
- **`customerNote`** — **не изменяется автоматически** при синхронизации ни в какую сторону
  (только явным действием owner/callcenter в Floremart). У Shopify нет отдельного
  назначенного поля под "заметку клиента" в нашем смысле — у этого магазина открытку и
  заметку клиенты не разделяют на два разных поля чекаута, поэтому мы не пытаемся
  выдумывать источник для customerNote и оставляем его целиком ручным.
- **`cardMessage` и адрес получателя** (`recipientName/Phone`, `addressLine`, `apartment`,
  `city`, `zip`) — **действительно двусторонние**: правка в Floremart уходит в Shopify
  (`shipping_address`/`note`, см. `pushUpdate.ts`), а `orders/updated` подтягивает их обратно
  (см. `applyUpdateFromShopify`/`extractAddressAndCardMessage` в `ingestOrder.ts`) — открытка
  у этого магазина хранится именно в стандартном поле заказа `note`, а не в
  `note_attributes`. Правки почти одновременно с обеих сторон не разрешаются каким-то
  конфликт-резолвером — побеждает тот, чья запись пришла последней (осознанно принятый
  компромисс, без UI-индикации конфликта).
- Переносы строк и исходный текст сохраняются (`whitespace-pre-wrap` при выводе).

## 13. Правила фоновых задач (`src/lib/jobs.ts`)

- Единая точка постановки задач `enqueue(name, payload)`.
- Этап 1 — исполнение инлайн (лог). Этап 2 — BullMQ/Redis за той же сигнатурой.
- Через задачи идут: уведомления флористу (Telegram), обратная синхронизация, SMS/email.
  Вебхук ставит задачу и сразу отвечает.

## 14. Правила хранения фотографий (`src/lib/storage.ts`)

- Фото НЕ хранятся в БД. В БД — только ссылки (`bouquetPhotoUrl`, `deliveryPhotoUrl`) и метаданные.
- Этап 1 — локальный диск `public/uploads` через интерфейс `ImageStorage`.
- Этап 2 — S3-совместимый адаптер за тем же интерфейсом (замена реализации без правки вызовов).
- Флорист загружает фото букета (выбор файла/камера, предпросмотр, замена до сохранения). Фото не
  обязательно для статуса «Готов».

## 15. Production-инфраструктура

Деплой — CloudPanel (Nginx reverse proxy + Let's Encrypt) + PM2 на VPS, без Vercel/serverless.
Полная инструкция, команды первого деплоя/обновления/отката/бэкапа — в [DEPLOY.md](./DEPLOY.md).
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
  Sync" из Shopify Dev Dashboard, одни на все подключаемые магазины (см. п.11). `APP_URL`
  (по умолчанию `https://floremart.com`) должен побайтово совпадать с `redirect_uri`,
  зарегистрированным в `../floremart-shopify-app/shopify.app.toml`.
- **Только Prisma Migrations** в production: `prisma migrate deploy`. Никогда `prisma db push`
  или `prisma migrate reset` — необратимо и не подходит для боевых данных.
- **Тестовые данные — только для разработки**: `npm run db:seed` не должен запускаться
  в production (`deploy.sh` его не вызывает и не должен начать).
- **Secure cookies**: `src/lib/auth.ts` всегда ставит `Secure` на cookie сессии в
  `NODE_ENV=production`, независимо от того, что Next.js видит на внутреннем hop между Nginx
  и `next start` (это нормально — браузер общается только с Nginx по HTTPS).

## 16. Команды

Требуется **Node.js ≥ 20.9** (проект разрабатывается на Node 24 — `nvm use 24`).
Переменные: `DATABASE_URL`, `AUTH_SECRET` в `.env`.

```bash
npm install          # зависимости (postinstall сам вызовет prisma generate)
npm run db:generate  # сгенерировать клиент Prisma вручную
npm run db:migrate   # применить миграции (dev, интерактивно)
npm run db:deploy    # применить миграции (prod, неинтерактивно)
npm run db:seed      # залить тестовые данные (18 сценариев)
npm run db:studio    # Prisma Studio (просмотр БД)
npm run create-owner # создать первого владельца (только вручную, см. п.15)
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

## 17. Запрещённые / опасные действия

- Не хранить фото и секреты в БД; не хранить заказы в JSON-файлах.
- Не привязываться к Vercel/serverless, Kubernetes, Firebase/MongoDB как основной базе.
- Не смешивать код адаптеров с бизнес-логикой.
- Не отдавать колл-центру финансовые данные ни в каком виде (в т.ч. через новые поля/эндпоинты).
- Флористу — не отдавать `estimatedProfit`, `deliveryActualCost` и цены/заказы других флористов
  ни при каком значении `financeVisibility` (только `tax/tip/discount/deliveryCustomerCost/
  customerTotal` по СВОИМ заказам допустимы, и только в режиме FULL — см. п.5–6).
- Не менять `customerNote` автоматически при синхронизации ни в какую сторону — у Shopify
  нет для него отдельного поля, это чисто ручное поле владельца/колл-центра (см. п.11–12).
  `cardMessage` и адрес получателя — исключение, они осознанно двусторонние
  (`pushUpdate.ts` + `applyUpdateFromShopify`, через стандартное поле заказа Shopify
  `note`), не путать с этим правилом.
- Не пересчитывать цену старых заказов при изменении прайса (снимок неизменен).
- Не коммитить `.env`, `public/uploads`, реальные токены/строки подключения.
- Не удалять/не перезаписывать данные без явного запроса; деструктивные git-операции — с осторожностью.
- В production — никогда `prisma db push`/`prisma migrate reset`, никогда `db:seed`.
- Не менять глобальную конфигурацию сервера (Nginx/PHP/CloudPanel/systemd) и чужие
  Virtual Host'ы/сайты/PM2-процессы/сертификаты без явного отдельного подтверждения — см. DEPLOY.md.

## 18. Порядок дальнейшей разработки

1. (Готово, этап 1) Ядро: авторизация, роли, сайты, товары, цены (в т.ч. редактируемые прайсы
   флористов и переключатель `financeVisibility`), заказы, распределение, UI ролей, интеграционные
   тесты ядра назначения.
2. (Готово) Shopify: OAuth-подключение магазина, приём и идемпотентный маппинг заказов через
   вебхуки, авто-назначение флориста. Не сделано: `pushUpdate` (обратная запись изменений в
   Shopify), периодический добор пропущенных заказов, реальная фоновая очередь вместо синхронной
   обработки в вебхуке (см. п.11).
3. WooCommerce (вебхуки + идемпотентность + обратная запись) — каркас есть, не реализовано.
4. BullMQ/Redis вместо ин-мемори очереди/синхронной обработки; периодический добор пропущенных заказов.
5. Telegram-уведомления флористам (приём принятия/отказа).
6. Quo (SMS/email) и Burq (доставка).
7. S3-совместимое хранилище фото.
8. Остальные управляющие формы админ-разделов (создание/редактирование приоритетов
   флористов по сайту, пользователей) — сейчас в режиме просмотра; сайты (включая Shopify-
   подключение), цены товаров и видимость финансов флориста уже редактируемы.

Внешние API не подключать одновременно; сначала стабилизировать уже подключённое.

---

@AGENTS.md
