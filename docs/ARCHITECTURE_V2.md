# Floremart — Architecture V2 (map & target)

Составлено Lead Architect в ходе ночного аудита (2026-07-17). Это **карта фактической
системы** + целевые границы. Существующие документы (`docs/ARCHITECTURE.md`, `HANDOFF.md`)
не переписаны — здесь фиксируется срез «как есть» и направление «как должно быть».

## 1. Стек
Next.js 16 (App Router, Turbopack, React 19) · TypeScript strict · Prisma 7 (+ `@prisma/adapter-pg`,
Postgres) · Tailwind v4 · Vitest. Деплой: single VPS, PM2 (`floremart`, порт 3010), процесс `deploy-fast.sh`.

## 2. Слои и разрешённое направление зависимостей

```
app/ (routes, RSC, client components, server actions)
  │  зависит от
  ▼
modules/ (бизнес-логика: orders, pricing, assignments, catalog, purchase)
  │  зависит от
  ▼
integrations/ (адаптеры внешних систем: shopify, woocommerce, delivery, messaging, notifications)
  │  зависит от
  ▼
lib/ (инфраструктура: db, auth, rbac, jobs, statuses, money, phone, tz, featureFlags)
  │  зависит от
  ▼
generated/prisma (клиент/типы БД)
```

**Правила границ (инварианты):**
- `app` не импортирует SDK внешних платформ напрямую — только через `modules`/`integrations`.
- `modules` работают с нормализованными типами и интерфейсами адаптеров, а не с сырыми Shopify/Woo.
- Всё, что помечено `import "server-only"`, никогда не попадает в клиентский бандл.
- Client Components получают только сериализуемые props (Decimal → number через `toNumber`, Date → сериализуемо).
- Реестры (`integrations/catalog.ts`) резолвят адаптер по `platform` через exhaustive switch — не разбросанные `if`.

## 3. Роли и маршруты
Три роли (`Role`): `OWNER`, `FLORIST`, `CALL_CENTER`. Гейтинг — `lib/rbac.ts`
(`requireUser` / `requireRole` / `requireFlorist`), редирект на домашнюю по роли.

| Сегмент | Роль | Назначение |
|---|---|---|
| `dashboard/(owner)` | OWNER | orders, order details, products, sites, florists, users, dashboard |
| `dashboard/(callcenter)` | CALL_CENTER | заказы без финансов (общение с клиентом) |
| `dashboard/(florist)` | FLORIST | только свои заказы (где `currentFloristId = self`) |
| `api/webhooks/[platform]` | — | приём вебхуков Shopify/Woo |
| `api/integrations/shopify/oauth/callback` | — | установка магазина (OAuth) |
| `api/health` | — | healthcheck |

## 4. Ключевые модули (бизнес-логика)
- **orders** (`modules/orders/`): `queries.ts` (фильтры/сортировки, ролевые списки), `serialize.ts`
  (ролевые проекции — финансы только владельцу, цена флориста только своя, колл-центр без цен),
  `metrics.ts`, `sync.ts`.
- **pricing** (`modules/pricing/service.ts`): резолв цены изготовления по приоритету
  (override флориста на вариант → цена варианта → override на товар → цена товара → полная стоимость),
  снимок цены в момент назначения, `recomputeEstimatedProfit` (= itemsTotal − floristTotal − deliveryActualCost).
- **assignments** (`modules/assignments/service.ts`): приоритетное авто-назначение, accept/decline/reassign,
  ручная цена, идемпотентность и транзакции; отказ передаёт заказ следующему по приоритету.
- **catalog** (`modules/catalog/`): sync товаров/вариантов, состав букета.
- **purchase** (`modules/purchase/list.ts`): агрегирование «Сегодня нужно купить».

## 5. Пять раздельных статусов заказа
`paymentStatus` · `orderStatus` · `assignmentStatus` · `deliveryStatus` · `syncStatus` —
семантические тона в `lib/statuses.ts` (neutral/info/success/danger). Терминальные:
`DELIVERED`, `CANCELLED`. Финансовые поля — раздельные Decimal(10,2).

## 6. Интеграции (состояние)
- **Shopify** — реальная: OAuth-установка, вебхуки заказов (HMAC по raw body, идемпотентный
  create-then-catch по `@@unique([siteId, externalId])`), backfill истории, каталог, картинки,
  push обновлений (адрес/открытка двусторонние). См. `INTEGRATION_ARCHITECTURE.md`.
- **WooCommerce** — заглушки адаптеров (каталог/заказы) под флагом `WOOCOMMERCE_ENABLED`.
- **Burq** (доставка), **Quo** (SMS/email), **Telegram** (уведомления) — стабы через `lib/jobs.enqueue`,
  под флагами. Реального сетевого вызова нет (этап 1).

## 7. Фоновые задачи
`lib/jobs.ts` — абстракция `enqueue(name, payload)`. Этап 1: инлайн-лог (нет воркера/очереди).
Целевое: заменяемо на BullMQ/Redis без изменения вызовов бизнес-логики. **Наблюдение:** сейчас
enqueue не имеет потребителя-воркера — задачи логируются, но не исполняются; для реальных
уведомлений нужен процессор (см. `INTEGRATION_ARCHITECTURE.md` §Event-driven).

## 8. Наблюдения по техдолгу (вход в REFACTOR_BACKLOG.md)
1. `lib/jobs.enqueue` без обработчика — уведомления/пуш-синк де-факто no-op после постановки.
2. Дублирование связки статус→бейдж (`StatusBadge.tsx` ок, но тон-классы в `statuses.ts` смешаны:
   часть на семантических TONE, часть на ad-hoc цветах — стоит унифицировать на токенах).
3. Нормализованные типы существуют только для каталога; заказы/клиент/адрес/доставка/сообщения
   ещё не нормализованы — платформенная форма Shopify частично протекает в ingest.
4. Нет типизированных ошибок адаптеров и централизованной retry-политики.
5. `metrics.ts`/списки заказов без пагинации — риск при росте числа заказов (performance-reviewer).

## 9. Целевое (V2, безопасно и постепенно)
- Полный набор нормализованных типов (заказ/клиент/адрес/статусы/события доставки/сообщения).
- Единые интерфейсы адаптеров: `CatalogAdapter`, `OrderAdapter`, `DeliveryAdapter`, `MessagingAdapter`,
  `WebhookAdapter`, `ConnectionAdapter` (+ реестры).
- In-process типизированная шина доменных событий с идемпотентностью и retry-метаданными,
  заменяемая на Redis/BullMQ.
- Единая инфраструктура уведомлений (SMS/Telegram/email/push) за `MessagingAdapter` с mock-провайдерами.
- Дизайн-токены и унификация UI-примитивов; Orders как эталон.
