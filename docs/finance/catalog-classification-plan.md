# Товарная финансовая классификация и закупочная стоимость ваз

Проект на согласование. Код не изменён, миграции нет.
Список ваз для разметки — [vase-review-list.md](./vase-review-list.md).

---

## 1. Фактическая модель каталога (аудит)

| Что | Как есть сейчас |
|---|---|
| `Product` | name, image, `productType`, status, `floristPrice Decimal?`, min/maxPrice, `defaultFloristComposition`, ссылки, поля синхронизации |
| `ProductVariant` | title, sku, `listPrice`, compareAtPrice, option1–3, inventoryQty, available, `floristComposition`, `floristPrice Decimal?`, position, поля синхронизации |
| Финансовый тип | **отсутствует** на обоих уровнях |
| Стоимость вазы | **нигде не хранится** |
| `productType` | `null` (275), `simple` (168), `variable` (145) — типы WooCommerce, как финансовая категория непригодны |
| Локальные поля владельца | `floristPrice`, `floristComposition`, `defaultFloristComposition` — sync их **уже не перезаписывает** ([sync.ts:67,97](src/modules/catalog/sync.ts:67), [productWrite.ts:42,69](src/integrations/woocommerce/productWrite.ts:42)) |
| Данные | 588 товаров, 923 варианта; `floristPrice` задан у 677 вариантов и у 0 товаров |
| Права | весь каталог — через `ownerOnly()` в [(owner)/actions.ts](src/app/dashboard/(owner)/actions.ts) |

---

## 2. Обновлённая Prisma-схема

Единый enum, общий с будущим финансовым модулем (не урезанный под каталог):

```prisma
enum FinancialItemType {
  FLOWER_PRODUCT
  VASE
  TIP
  DELIVERY
  TAX
  SERVICE_FEE
  DISCOUNT
  CARD
  GIFT
  OTHER
}

model Product {
  // ...существующие поля...
  /// Значение по умолчанию для вариантов. Задаётся ТОЛЬКО владельцем.
  /// productType (simple/variable) финансовым типом не является.
  financialType        FinancialItemType?
  /// Дефолт «содержит вазу». null = не задано, наследовать нечего.
  defaultIncludesVase  Boolean?

  vaseCosts VasePurchaseCost[]
}

model ProductVariant {
  // ...существующие поля...
  /// null = наследовать Product.financialType; значение = переопределить.
  financialType FinancialItemType?

  /// ТРИ состояния, поэтому Boolean? без @default:
  ///   null  — наследовать Product.defaultIncludesVase / неизвестно
  ///   true  — букет с включённой вазой
  ///   false — подтверждённо без вазы
  includesVase Boolean?

  financialTypeSetBy String?
  financialTypeSetAt DateTime?

  vaseCosts VasePurchaseCost[]
}
```

Закупочная стоимость **не хранится колонкой на варианте** — только в effective-dated модели ниже.
Это исключает вторую точку правды и делает невозможным «поменяли цену — поехал старый заказ».

```prisma
enum VaseCostType {
  STANDALONE_VASE // financialType = VASE: закупочная себестоимость самой вазы
  INCLUDED_VASE   // FLOWER_PRODUCT + includesVase: себестоимость вазы внутри букета
}

/// История закупочной стоимости с датами действия. Уровень определяется тем, какая из двух
/// ссылок заполнена: ровно одна (CHECK num_nonnulls(productId, productVariantId) = 1).
/// Записи не редактируются: смена цены закрывает текущий интервал и открывает новый.
model VasePurchaseCost {
  id               String       @id @default(cuid())
  productId        String?
  productVariantId String?
  costType         VaseCostType
  purchaseCostCents Int
  currency         String       @default("USD")
  effectiveFrom    DateTime
  effectiveTo      DateTime?
  comment          String?
  createdBy        String
  createdAt        DateTime     @default(now())

  product String? @relation(fields: [productId], references: [id], onDelete: Restrict)
  variant String? @relation(fields: [productVariantId], references: [id], onDelete: Restrict)

  @@index([productVariantId, costType, effectiveFrom])
  @@index([productId, costType, effectiveFrom])
}

/// Общий финансовый аудит. Заводится этой миграцией и переиспользуется финансовым модулем.
model FinanceAudit {
  id         String   @id @default(cuid())
  entity     String   // "ProductVariant" | "Product" | "VasePurchaseCost"
  entityId   String
  action     String   // "SET_TYPE" | "SET_INCLUDES_VASE" | "SET_COST" | "RESET_TO_INHERIT" | "BULK_CLASSIFY"
  beforeJson Json?
  afterJson  Json?
  reason     String?  // обязателен для bulk-операций
  batchId    String?  // одна bulk-операция = один batchId
  userId     String
  role       Role
  createdAt  DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([entity, entityId, createdAt])
  @@index([batchId])
  @@index([userId, createdAt])
}
```

### Почему история обязательна, а не избыточна

Без дат действия изменение закупочной стоимости сегодня немедленно изменило бы расчёт
**незакрытого вчерашнего заказа**: финансовый снимок пересчитывается при любом изменении входных
данных, а «текущая» стоимость — часть входа. Заказ, ещё не попавший в закрытый период, тихо
поменял бы прибыль задним числом. Effective-dated модель решает это на уровне данных:
расчёт резолвит стоимость **на дату доставки заказа**, а не «сейчас». Закрытые периоды защищены
дополнительно неизменяемостью ревизий снимка, но полагаться только на них нельзя — они
защищают уже посчитанное, а не то, что считается прямо сейчас.

---

## 3. Наследование Product → ProductVariant

| Значение | Порядок разрешения |
|---|---|
| `financialType` | `variant.financialType` → `product.financialType` → **UNCLASSIFIED** (null) |
| `includesVase` | `variant.includesVase` → `product.defaultIncludesVase` → **unknown** (null) |
| Стоимость включённой вазы | `VasePurchaseCost(variant, INCLUDED_VASE, на дату)` → `VasePurchaseCost(product, INCLUDED_VASE, на дату)` → **unknown** |
| Стоимость самостоятельной вазы | `VasePurchaseCost(variant, STANDALONE_VASE, на дату)` → `VasePurchaseCost(product, STANDALONE_VASE, на дату)` → **unknown** |

Резолвер — одна чистая функция `resolveVariantFinance(variant, product, costs, atDate)`; в UI и
в расчёте используется только она. Различаются три состояния, и они не схлопываются:

* **inherited** — своего значения нет, действует значение товара;
* **override** — своё значение задано (в том числе `false`);
* **unknown** — не задано нигде; для стоимости это `VASE_COST_MISSING`, для типа `ITEM_UNCLASSIFIED`.

---

## 4. Bulk-review: рабочий процесс

Отдельный экран `/dashboard/products/classification`, OWNER-only. Остаётся постоянным
инструментом: новые импортированные товары автоматически попадают в очередь «без классификации».

**Колонки:** ☐ выбор · Магазин · Товар · Вариант · Цена клиента · Цена флориста ·
Текущий тип (с пометкой «унаследовано») · Предложенный тип · Предложенный `includesVase` ·
Текущая закупочная стоимость · Confidence · Reason.

**Фильтры и поиск:** магазин, текущий тип, «без классификации», «без закупочной стоимости»,
«есть override у вариантов», поиск по названию и SKU.

**Массовые действия:** установить тип · установить `includesVase` · установить закупочную
стоимость · вернуть к наследованию.

**Порядок:** выбор строк → массовое действие → **preview со списком конкретных изменений
(было → станет)** → исключение отдельных строк прямо в preview → подтверждение → запись
одной транзакцией: значения + новые интервалы `VasePurchaseCost` + записи `FinanceAudit`
с общим `batchId` и обязательной причиной.

Ничего не записывается до подтверждения. Автоматической классификации при импорте нет:
platform category используется только как suggestion и никогда не переписывает подтверждённое
владельцем значение.

---

## 5. Примеры

**5.1. Самостоятельная ваза** — `Clear Glass Cylinder Vase 7 1/2 in`, THEFLOW, $40.00

```
ProductVariant: financialType = VASE, includesVase = null
VasePurchaseCost: STANDALONE_VASE, 1200 (=$12.00), effectiveFrom 2026-09-01, effectiveTo null
```
Цена клиента $40.00 остаётся выручкой. Закупочная — $12.00, и только она попадёт в расход.

**5.2. Букет с вазой** — `24 Red Roses & Vase / Clear Glass Vase 8 in`, $185.00, флористу $100.00

```
ProductVariant: financialType = FLOWER_PRODUCT (унаследован), includesVase = true
VasePurchaseCost: INCLUDED_VASE, 1200, effectiveFrom 2026-09-01
```
Вся выручка $185.00 остаётся цветочной; отдельным расходом вычитается $12.00.

**5.3. Букет без вазы** — `Sweet Kiss - Standard, No Vase`, $145.00

```
ProductVariant: financialType = FLOWER_PRODUCT, includesVase = false
VasePurchaseCost: записей нет
```
`false` — подтверждённое отсутствие вазы, не unknown; `VASE_COST_MISSING` не поднимается.

**5.4. Разные варианты одного товара** — `Apricot & Vase`

```
Product: financialType = FLOWER_PRODUCT, defaultIncludesVase = true
         VasePurchaseCost(product, INCLUDED_VASE) = 1200

Вариант «Clear Glass Vase 8 in»   → всё унаследовано: includesVase = true, стоимость $12.00
Вариант «Sage Sculptural Vase»    → override стоимости: VasePurchaseCost(variant) = 2600
Вариант «Standard, No Vase»       → override признака: includesVase = false, стоимости нет
```

**5.5. Изменение закупочной стоимости во времени**

```
VasePurchaseCost(variant X, INCLUDED_VASE, 1200, from 2026-09-01, to 2026-11-01)
VasePurchaseCost(variant X, INCLUDED_VASE, 1500, from 2026-11-01, to null)
```
Заказ с доставкой 2026-10-15 всегда считается по $12.00 — и сегодня, и после подорожания.
Заказ от 2026-11-20 — по $15.00. Старая строка не редактируется и не удаляется.

---

## 6. Поля, которые синхронизация не перезаписывает никогда

Добавляются в тот же перечень исключений, что уже действует для цен флориста
([sync.ts](src/modules/catalog/sync.ts), [productWrite.ts](src/integrations/woocommerce/productWrite.ts)):

| Модель | Поля |
|---|---|
| `Product` | `floristPrice`, `defaultFloristComposition`, **`financialType`**, **`defaultIncludesVase`** |
| `ProductVariant` | `floristPrice`, `floristComposition`, **`financialType`**, **`includesVase`**, **`financialTypeSetBy`**, **`financialTypeSetAt`** |
| `VasePurchaseCost` | вся таблица — sync её не видит и не пишет |
| `FinanceAudit` | вся таблица |

Товар, исчезнувший на платформе, получает `remoteDeleted`, но классификация, стоимости и история
остаются локально: они не участвуют в upsert и не удаляются каскадом (`onDelete: Restrict`).

Тест на регрессию: заполнить все поля вручную → прогнать upsert Shopify и Woo с изменёнными
данными платформы → убедиться, что ни одно из перечисленных полей не изменилось.

---

## 7. Праздничные доплаты: их четыре, не две

| Магазин | Товар | Цена | Handle | Предложение |
|---|---|---:|---|---|
| FLWBR | `Additional charge on Valentine's Day` | $39.00 | `additional-charge-on-valentines-day` | **SERVICE_FEE** |
| PAR | `Mother's Day Delivery Extra Fees` | $49.00 | `mothers-day-delivery-extra-fees` | **DELIVERY** — доплата именно за доставку, подтверждается и названием, и handle |
| OHARA | `Mother’s Day Extra Fee` | $45.00 | `mother-s-day-flower-price-increase` | **needs review** — handle говорит «flower price increase», то есть это наценка на цветы, а не сервис |
| PAR | `Valentine's Day surcharge` | $29.00 | `valentines-day-delivery` | **needs review** — название говорит «surcharge», handle говорит «delivery» |

Все четыре ни разу не заказаны (`times_ordered = 0`), поэтому на текущие финансовые данные они
не влияют. Два спорных не классифицирую — они пойдут в bulk-review с пометкой needs review.

---

## 8. Классификация существующих вариантов

648 «обычных» вариантов **не размечаются автоматически**. До подтверждения владельцем они
остаются `financialType = null` (UNCLASSIFIED); dry-run лишь предлагает `FLOWER_PRODUCT`.
Финансовый модуль до подтверждения ставит `ITEM_UNCLASSIFIED` и снимок `PRELIMINARY`.

Готовые к разметке группы:

| Группа | Вариантов | Как размечать |
|---|---:|---|
| Букеты с вазой (`«… & Vase - …»`) | 155 | bulk: тип FLOWER_PRODUCT + includesVase = true, стоимость по названию вазы |
| Кандидаты в самостоятельные вазы | 76 | [vase-review-list.md](./vase-review-list.md), поштучно с галочками |
| Подарки | 34 | bulk: GIFT |
| Открытки | 9 | bulk: CARD |
| Праздничные доплаты | 4 | 2 сразу, 2 — needs review |
| Остальные | 645 | предложение FLOWER_PRODUCT, подтверждение владельцем |

---

## 9. Миграция и backfill

1. **Миграция**: новый enum, три nullable-поля на `Product`/`ProductVariant`, две таблицы
   (`VasePurchaseCost`, `FinanceAudit`), CHECK-constraint на ровно одну ссылку в `VasePurchaseCost`,
   индексы. Существующие данные не изменяются, дефолтов, меняющих смысл, нет.
2. **Backfill: отсутствует.** Ни одно значение не проставляется скриптом — только через
   bulk-review с подтверждением.
3. **Порядок работ:** миграция → резолвер и тесты → поля в модалке варианта и карточке товара →
   бейджи и фильтры в списке → экран bulk-review → разметка владельцем.
4. Финансовый модуль (Stage 1) продолжается **после** разметки: до неё стоимость вазы = unknown,
   что честно отражается статусом `PRELIMINARY`.

---

## 10. Тесты

1. самостоятельная ваза хранит стоимость в `VasePurchaseCost(STANDALONE_VASE)`;
2. букет с вазой остаётся `FLOWER_PRODUCT`, тип не подменяется на VASE;
3. `No Vase` → `includesVase = false`, стоимость не требуется и не создаётся;
4. разные варианты одного товара: наследование, override стоимости, override признака;
5. sync Shopify и Woo не сбрасывает ни одно поле из §6;
6. отсутствие записи стоимости = unknown, а не 0;
7. `0` сохраняется как подтверждённый ноль и отличим от unknown;
8. `listPrice` не используется как закупочная стоимость ни в одной ветке резолвера;
9. слово «vase» в названии само по себе не меняет тип (`Sweet Kiss - Standard, No Vase`, `Apricot & Vase`);
10. права: запись только OWNER, флорист и колл-центр получают отказ;
11. смена стоимости не меняет расчёт заказа с прошлой датой доставки;
12. bulk-операция пишет `FinanceAudit` с общим `batchId` и причиной на каждую изменённую строку.
