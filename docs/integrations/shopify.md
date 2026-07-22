# Shopify-интеграция (реализовано) и WooCommerce (каркас)

> Общая архитектура и модель данных — см. [../ARCHITECTURE.md](../ARCHITECTURE.md).

Внутренняя БД — первоисточник. Каждый заказ хранит `externalId`, `platform`, `syncStatus`,
`lastSyncedAt`. Новые заказы приходят вебхуком сразу после подключения сайта; для загрузки
истории по уже подключённому магазину есть отдельный разовый скрипт
`scripts/backfill-shopify-orders.ts` (см. `Order.isBackfilled`) — обычный импорт истории
при подключении по-прежнему не делается автоматически.

## 1. Shopify — реальная интеграция

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
  **адрес получателя и `cardMessage`** (см. раздел 2 — они действительно двусторонние поля
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
  перевести на BullMQ (см. [../ARCHITECTURE.md](../ARCHITECTURE.md), «Правила фоновых задач»)
  и вернуться к исходному плану.
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
владельца/колл-центра, у Shopify нет для него отдельного назначенного поля (см. раздел 2).

## 2. Правила работы с cardMessage и customerNote

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

**Запрещено** (перенесено из «Запрещённые/опасные действия», см.
[../ARCHITECTURE.md](../ARCHITECTURE.md)): менять `customerNote` автоматически при
синхронизации ни в какую сторону — у Shopify нет для него отдельного поля, это чисто
ручное поле владельца/колл-центра (см. разделы 1–2 выше). `cardMessage` и адрес
получателя — исключение, они осознанно двусторонние (`pushUpdate.ts` +
`applyUpdateFromShopify`, через стандартное поле заказа Shopify `note`), не путать с
этим правилом.

## 3. WooCommerce — каркас, не реализовано

Адаптер (`src/integrations/woocommerce/adapter.ts`) — заглушка за флагом `WOOCOMMERCE_ENABLED`.
