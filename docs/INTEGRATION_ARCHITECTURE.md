# Floremart — Integration Architecture

Универсальная основа для добавления интеграций без копирования бизнес-логики.
Составлено Integration Architect (2026-07-17). Реализация — additively поверх
существующего `src/integrations/` (см. `src/integrations/types.ts`).

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
| `CatalogAdapter` | импорт товаров/вариантов (stream) | ✅ есть |
| `OrderAdapter` | parseWebhook → `NormalizedOrder`, pushUpdate | ↔ расширяет текущий `OrderSourceAdapter` |
| `DeliveryAdapter` | createDelivery, getStatus, parseWebhook → `NormalizedDeliveryEvent` | ✅ есть (расширить) |
| `MessagingAdapter` | send(command) → `MessageResult` по каналам | ↔ унифицирует текущий SMS/email |
| `WebhookAdapter` | verify(raw, headers, secret) → ok/replay/invalid; extractEventId | 🆕 |
| `ConnectionAdapter` | connect/disconnect/status, credential shape | 🆕 |

Совместимость: текущий `OrderSourceAdapter`/`MessagingAdapter` сохраняются как есть; новые
контракты добавляются рядом и внедряются по мере появления второго реального потребителя
(правило «не абстрагировать ради будущего» — см. `AUTONOMOUS_REFACTOR_REPORT.md`).

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

## 9. Уведомления
Единый `MessageCommand` (channel, to, templateId, vars, idempotencyKey) → `MessagingAdapter.send`
→ `MessageResult` (status, providerId, error?, retryable?). Шаблоны — `messaging/templates.ts`.
Провайдеры SMS/email/Telegram/push реализуются за этим интерфейсом; ночью — mock-провайдеры.
Quo и Telegram — безопасные skeleton-адаптеры без production-вызовов.

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
