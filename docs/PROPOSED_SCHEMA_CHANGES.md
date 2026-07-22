# Proposed Schema Changes (НЕ применено)

Предложения по схеме БД, вытекающие из ночной подготовки интеграционной/событийной основы.
**Ничего из этого не применено**: `prisma/schema.prisma` не изменён, миграций не создавалось,
БД не трогалась. Это вход для решения владельца. Все предложения спроектированы как
**неразрушающие** (nullable/default/новые таблицы) — без обязательных полей на существующих моделях.

Легенда риска: 🟢 additive (nullable/новая таблица) · 🟡 требует бэкофилла · 🔴 разрушающее.

---

## 1. WooCommerce credentials на Site 🟢
Сейчас `Site` хранит только Shopify-поля. Для реального Woo нужны:
```prisma
// model Site (ДОБАВИТЬ, все nullable):
wooBaseUrl        String?  // https://shop.example.com
wooConsumerKey    String?  // ck_...
wooConsumerSecret String?  // cs_...
wooWebhookSecret  String?  // секрет подписи вебхуков Woo
```
Риск: 🟢. Причина: `ConnectionCredentials`/`wooCommerceConnectionAdapter` уже ждут эти данные.
Секреты — как и Shopify-токен, хранить только серверно; в UI не отдавать.

## 2. Персистентная идемпотентность вебхуков/событий 🟢
Сейчас дедуп событий — in-memory (`events/bus.ts`), теряется при рестарте PM2. Для надёжной
идемпотентности между рестартами:
```prisma
model ProcessedEvent {
  id             String   @id @default(cuid())
  idempotencyKey String   @unique  // "${name}::${key}" события или id вебхука
  source         String   // "shopify" | "woocommerce" | "event-bus" | ...
  processedAt    DateTime @default(now())
  @@index([source])
}
```
Риск: 🟢 (новая таблица). Позволяет заменить in-memory `seen` на БД-проверку.
Для заказов идемпотентность уже обеспечена `@@unique([siteId, externalId])` — это дополняет её
для уведомлений/событий, где нет естественного уникального ключа.

## 3. Outbox для надёжной публикации событий 🟢
Для гарантии доставки доменных событий при замене in-process шины на Redis/BullMQ:
```prisma
model OutboxEvent {
  id             String   @id @default(cuid())
  name           String   // "order.delivery.completed" ...
  payload        Json
  idempotencyKey String   @unique
  status         String   @default("PENDING") // PENDING | PROCESSED | FAILED
  attempts       Int      @default(0)
  createdAt      DateTime @default(now())
  processedAt    DateTime?
  @@index([status])
}
```
Риск: 🟢. Внедрять вместе с воркером (см. отчёт, блок «нет потребителя jobs»).

## 4. Расширение каналов сообщений 🟡
`MessageChannel` в Prisma сейчас `SMS | EMAIL`. Инфраструктура уведомлений поддерживает
`TELEGRAM | PUSH`. Предложение — добавить значения enum:
```prisma
enum MessageChannel { SMS EMAIL TELEGRAM PUSH } // +TELEGRAM +PUSH
```
Риск: 🟡 — добавление значений enum в Postgres безопасно (не разрушающе), но требует миграции
и согласования, поэтому вынесено сюда, а не сделано ночью. `messaging/normalized` уже использует
расширенный union на уровне TS.

## 5. Лог доставки уведомлений 🟢
Для наблюдаемости отправок (кому/каким каналом/статус) — вместо/в дополнение к текущему `Message`:
```prisma
model NotificationDelivery {
  id             String   @id @default(cuid())
  orderId        String?
  channel        String   // SMS|EMAIL|TELEGRAM|PUSH
  to             String
  templateId     String
  status         String   // sent|skipped|failed
  providerId     String?
  idempotencyKey String   @unique
  createdAt      DateTime @default(now())
  @@index([orderId])
}
```
Риск: 🟢 (новая таблица). Даёт аудит и защиту от дублей на уровне БД.

## 6. Внешние поля доставки на Order 🟢
Для Burq/курьерских интеграций:
```prisma
// model Order (ДОБАВИТЬ, nullable):
deliveryProvider   String?  // "burq" ...
deliveryExternalId String?  // id доставки во внешней системе
```
Риск: 🟢. `trackingUrl` уже есть; это дополняет его идентификатором для опроса статуса/вебхуков.

---

## Что НЕ предлагается менять
- Финансовые поля и их семантика — без изменений (расчёты защищены).
- `OrderStatus`/`PaymentStatus`/ролевые enum — без изменений.
- Никаких удалений полей, переименований или изменения `onDelete` рабочих связей.

## Порядок применения (когда владелец решит)
1. Сначала additive-поля (1, 6) и новые таблицы (2, 3, 5) — безопасно, без даунтайма.
2. Enum (4) — отдельной миграцией, согласовав с кодом уведомлений.
3. Каждую миграцию — через обычный ревью и `deploy.sh` (не `deploy-fast`), с бэкапом БД.
