# Floremart — Integration Architecture

Универсальная основа для добавления интеграций без копирования бизнес-логики.
Составлено Integration Architect (2026-07-17). Реализация — additively поверх
существующего `src/integrations/` (см. `src/integrations/types.ts`).

> **Обновлено 2026-07-30.** Часть плана из этого документа не была реализована так, как
> задумывалась изначально: `OrderSourceAdapter` и `MessagingAdapter` (упомянутые ниже как
> «текущие») были ranние stage-1-заглушки (`console.log`, без реальных вызовов) и **удалены**
> при архитектурной чистке — реальные потоки заказов пошли напрямую через
> `OrderAdapter`/`WebhookAdapter`/`registry.ts` (Shopify/WooCommerce, оба реальные), а реальная
> отправка SMS/Email в автоматизациях реализована отдельно, в обход изначально задуманного
> единого `MessagingAdapter` (см. §9). Секции ниже оставлены как есть для истории замысла;
> актуальный статус — в `docs/HANDOFF.md`.

## 1. Принцип
Бизнес-модули и UI зависят ТОЛЬКО от нормализованных типов и интерфейсов адаптеров.
Платформенная специфика (Shopify/Woo/Burq/Quo/Telegram) живёт исключительно внутри
`integrations/<platform>/`. Добавление платформы = новый адаптер + регистрация в реестре.

```
UI / modules ──▶ Normalized types + Adapter interfaces ──▶ Registry ──▶ <platform> adapter ──▶ external API
                                       ▲
                              ConnectionProvider (credentials)
```

## 2. Нормализованные типы (контракт)
Расширяют существующие `NormalizedProduct`/`NormalizedVariant` (каталог уже нормализован).
Новые — в `src/integrations/normalized.ts`:

- `NormalizedAddress` — recipient/sender адрес (line1/line2/city/zip/country/phone/name).
- `NormalizedCustomer` — name/phone/email (+ external id).
- `NormalizedOrderItem` — externalId, name, variantName, sku, quantity, unitPrice, image,
  productExternalId, variantExternalId.
- `NormalizedOrder` — externalId, orderNumber, createdAt, deliveryDate/window, sender/recipient,
  cardMessage, customerNote, суммы (items/tax/tip/discount/deliveryCost/total), статусы (payment/fulfillment),
  items[], platform, raw.
- `NormalizedExternalStatus` — маппинг внешних статусов оплаты/выполнения на внутренние enum.
- `NormalizedDeliveryEvent` — provider, externalId, status (внутренний DeliveryStatus), trackingUrl, ts, raw.
- `NormalizedMessageEvent` — channel (SMS/EMAIL/TELEGRAM/PUSH), direction, party, externalId, body, ts, raw.

Все типы «плоские», сериализуемые, без Prisma.Decimal (числа), без Date-объектов на границе UI.

## 3. Интерфейсы адаптеров
В `src/integrations/types.ts` (существующие расширяются минимально):

| Интерфейс | Назначение | Существует? |
|---|---|---|
| `CatalogAdapter` | импорт товаров/вариантов (stream) | ✅ есть, Shopify+WooCommerce реальные |
| `OrderAdapter` | parseWebhook → `NormalizedOrder`, pushUpdate | ✅ есть; замышлявшийся `OrderSourceAdapter` — **удалён** (был неиспользуемой заглушкой) |
| `DeliveryAdapter` | createDelivery, getStatus, parseWebhook → `NormalizedDeliveryEvent` | ⚠️ этот интерфейс (в `integrations/types.ts`) — **удалён** вместе с заглушкой; реальная доставка — `integrations/delivery/burq/*`, свой контракт |
| `MessagingAdapter` | send(command) → `MessageResult` по каналам | ⚠️ **удалён** как неиспользуемая заглушка. Реальная отправка сейчас: `modules/automations/channels/*` (`ChannelSender`, SMS/Email автоматизаций, реальный) + `src/messaging/*` (mock-only, используется одним обработчиком `order.delivery.completed` — см. HANDOFF §8, техдолг) |
| `WebhookAdapter` | verify(raw, headers, secret) → ok/replay/invalid; extractEventId | ✅ есть |
| `ConnectionAdapter` | connect/disconnect/status, credential shape | ✅ есть |

Совместимость: изначально задумывалось держать `OrderSourceAdapter`/`MessagingAdapter` рядом
с новыми контрактами до появления второго реального потребителя. На практике второй потребитель
так и не появился до реального Shopify+WooCommerce (которые пошли через `OrderAdapter`
напрямую) — обе заглушки остались неиспользуемым мёртвым кодом и были удалены 2026-07-30.

## 4. Реестры
- `integrations/catalog.ts` — `getCatalogAdapter(platform)` (есть).
- `integrations/registry.ts` (🆕) — единая точка резолва order/webhook/connection адаптеров по платформе,
  exhaustive switch, `never`-default.

## 5. ConnectionProvider (credentials)
Единый источник credentials по сайту (`Site.shopify*`, будущие Woo consumer key/secret и т.д.).
Адаптеры получают credentials через провайдер, а не читают `process.env`/Prisma ad hoc.
Секреты приложения (client_id/secret) — общие, per-site токены — из БД. **Ночью реальные
credentials не используются**; провайдер возвращает типобезопасную форму, mock — в тестах.

## 6. Идемпотентность и локальные поля
- Ingest/push идемпотентны по стабильному ключу (`@@unique([siteId, externalId])` — источник истины).
- Внешняя синхронизация НИКОГДА не перезаписывает локальные поля Floremart: florist composition,
  florist price, оригиналы открытки/заметки. Маппинг → нормализация → явный merge с правилами.

## 7. Ошибки и retry
- `integrations/errors.ts` (🆕): `IntegrationError` с `kind: "retryable" | "permanent" | "auth" | "rate_limit"`.
- Централизованная политика ретраев (`integrations/retry.ts`, 🆕): экспоненциальный бэкофф,
  классификация по `kind`. Хендлеры не содержат собственной retry-логики.

## 8. Event-driven основа
`src/events/` (🆕): типизированный реестр доменных событий (`order.created`, `order.updated`,
`order.assigned`, `order.ready`, `order.delivery.*`, `order.cancelled`, `order.refunded`,
`product.synced`, `integration.connected`, `integration.failed`), payload-типы, idempotencyKey,
`EventHandler` интерфейс, retry-метаданные, журнал обработки, безопасная in-process реализация.
Заменяемо на Redis/BullMQ позже без изменения публикаторов/подписчиков.

`order.delivery.completed` может фан-аутить: SMS + Telegram + email + completion-sync в Shopify/Woo —
через подписчиков, НЕ хардкодом в webhook-хендлере.

## 9. Уведомления (как получилось на практике, не как задумывалось)

Единый `MessagingAdapter`/`MessageCommand` так и не стал точкой входа для реальной отправки.
Вместо этого сложились два независимых пути:

- **`modules/automations/channels/*`** (`ChannelSender`) — реальный, рабочий: SMS через QUO,
  Email через Brevo (per-Site настройки + опциональный override шаблона на уровне правила).
  Питает Automation Engine (`modules/automations/handlers.ts` + `outbox`).
- **`src/messaging/*`** (`MessagingService`, `subscribers.ts`, `templates.ts`) — обслуживает
  ровно один обработчик, `order.delivery.completed`, и до сих пор работает **только на
  mock-провайдерах** (`messaging/providers/mock.ts`) — реальных SMS/Email/Telegram/push оттуда
  не уходит. Зафиксировано как технический долг для отдельного аудита (см. `HANDOFF.md` §8):
  либо подключить сюда реальных провайдеров, либо переписать этот обработчик на `channels/*`.

Quo и Telegram как самостоятельные интеграции (звонки/записи, бот) реализованы отдельно в
`integrations/quo/*` и `integrations/telegram/*` — они реальные и не связаны с этим слоем.

## 10. Статус по платформам
| Платформа | Каталог | Заказы | Доставка | Сообщения | Вебхуки |
|---|---|---|---|---|---|
| Shopify | ✅ real | ✅ real (ingest/push) | — | — | ✅ HMAC real |
| WooCommerce | 🟡 skeleton | 🟡 skeleton | — | — | 🟡 skeleton |
| Burq | — | — | 🟡 stub | — | 🟡 (планируется) |
| Quo | — | — | — | 🟡 skeleton (SMS/email) | — |
| Telegram | — | — | — | 🟡 skeleton | — |
| SMS/email/push | — | — | — | 🟡 mock providers | — |

Блокеры на реальное подключение: credentials Woo/Burq/Quo/Telegram, решения по шаблонам сообщений
и по маппингу статусов Woo — вынесены в отчёт и `PROPOSED_SCHEMA_CHANGES.md` (где нужны поля БД).
