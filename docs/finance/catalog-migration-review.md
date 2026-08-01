# Миграция каталожной финансовой классификации — на проверку

Файл миграции: `prisma/migrations/20260801120000_catalog_finance_classification/migration.sql`.
**К проду не применялась.** Проверена на одноразовой локальной базе (Postgres 17), база удалена.

---

## 1. Prisma diff

```diff
 model Product {
   floristPrice              Decimal?  @db.Decimal(10, 2)
   minPrice                  Decimal?  @db.Decimal(10, 2)
   maxPrice                  Decimal?  @db.Decimal(10, 2)
+  // Задаёт ТОЛЬКО владелец; синхронизация не трогает.
+  // productType (simple/variable) финансовым типом НЕ является.
+  financialType             FinancialItemType?  // значение по умолчанию для вариантов
+  defaultIncludesVase       Boolean?            // NULL = не задано
   variants      ProductVariant[]
   floristPrices FloristProductPrice[]
+  vaseCosts     VasePurchaseCost[]
   @@unique([siteId, externalId])
   @@index([siteId])
+  @@index([financialType])
 }

 model ProductVariant {
   floristPrice       Decimal?  @db.Decimal(10, 2)
+  financialType      FinancialItemType?  // NULL = наследовать Product
+  includesVase       Boolean?            // NULL наследовать · true с вазой · false подтверждённо без
+  financialTypeSetBy String?
+  financialTypeSetAt DateTime?
   floristPrices FloristProductPrice[]
+  vaseCosts     VasePurchaseCost[]
   @@unique([productId, externalId])
   @@index([productId])
+  @@index([financialType])
+  @@index([includesVase])
 }

 model User {
   florist       Florist?
   orderAudits   OrderAudit[]
+  financeAudits FinanceAudit[]
 }

+enum FinancialItemType { FLOWER_PRODUCT VASE TIP DELIVERY TAX SERVICE_FEE DISCOUNT CARD GIFT OTHER }
+enum VaseCostType { STANDALONE_VASE INCLUDED_VASE }
+model VasePurchaseCost { … }   // см. schema.prisma
+model FinanceAudit { … }
```

Изменений типов, удалений колонок и `@default`, меняющих смысл существующих строк, нет.
Все новые поля добавляются как NULL: «не задано / наследовать», а не «ложь» и не «ноль».

## 2. Raw SQL constraints

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- нужен для EXCLUDE по (enum, диапазон)

-- ровно одна цель
CHECK (("productId" IS NOT NULL) <> ("productVariantId" IS NOT NULL))
-- себестоимость неотрицательна (0 допустим, «неизвестно» = отсутствие строки)
CHECK ("purchaseCostCents" >= 0)
-- период не пустой и не обратный
CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")

-- запрет пересечений: открытый интервал = до бесконечности, полуинтервал '[)'
EXCLUDE USING gist ("productVariantId" WITH =, "costType" WITH =,
  tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&)
  WHERE ("productVariantId" IS NOT NULL)

EXCLUDE USING gist ("productId" WITH =, "costType" WITH =,
  tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&)
  WHERE ("productId" IS NOT NULL)
```

Колонки — `TIMESTAMP(3)` без таймзоны, поэтому `tsrange`, а не `tstzrange`.
`'[)'` означает, что конец одного периода может совпадать с началом следующего — смена цены
не требует зазора в секунду.

### Проверено на живой базе

| Сценарий | Ожидание | Факт |
|---|---|---|
| ни одной цели | отказ | `VasePurchaseCost_single_target` |
| обе цели сразу | отказ | `VasePurchaseCost_single_target` |
| стоимость −1 | отказ | `VasePurchaseCost_cost_non_negative` |
| `effectiveTo` раньше `effectiveFrom` | отказ | `VasePurchaseCost_period_valid` |
| второй открытый интервал по той же цели и типу | отказ | `no_overlap_variant` |
| пересечение внутри закрытого интервала | отказ | `no_overlap_variant` |
| закрыли интервал и открыли новый той же датой | успех | ок |
| смежный интервал строго до первого | успех | ок |
| другой `costType` по той же цели | успех | ок |
| стоимость на товаре и на варианте одновременно | успех | ок (разные цели) |
| `purchaseCostCents = 0` | успех | ок |
| удаление варианта со стоимостью | отказ | FK Restrict |
| удаление товара со стоимостью | отказ | FK Restrict |
| два конкурентных открытых интервала | отказ второму | `no_overlap_variant` |

Резолв на дату на тех же данных (интервалы 07-01…08-01 = $10, 08-01…11-01 = $12, с 11-01 = $15):

```
2026-06-15 -> unknown      2026-07-15 -> $10.00
2026-10-15 -> $12.00       2026-11-20 -> $15.00
```

## 3. Индексы

| Таблица | Индекс |
|---|---|
| Product | `financialType` |
| ProductVariant | `financialType`, `includesVase` |
| VasePurchaseCost | `(productVariantId, costType, effectiveFrom)`, `(productId, costType, effectiveFrom)`, `effectiveTo` |
| FinanceAudit | `(entity, entityId, createdAt)`, `batchId`, `(userId, createdAt)` |

Плюс два GiST-индекса, создаваемых exclusion-constraint'ами — они же обслуживают выборку
пересечений при записи.

## 4. onDelete

| Связь | Политика |
|---|---|
| `VasePurchaseCost.product` → Product | **Restrict** |
| `VasePurchaseCost.variant` → ProductVariant | **Restrict** |
| `FinanceAudit.user` → User | **Restrict** |

Ни одна финансовая запись не исчезает каскадом. Товар, пропавший с платформы, помечается
`remoteDeleted`, но история стоимости и аудит остаются; в `FinanceAudit` дополнительно
хранятся `entityNameSnapshot` и `siteShortNameSnapshot`, поэтому отчёт читается и после этого.

## 5. `resolveVariantFinance`

```ts
export type EffectiveSource = "VARIANT" | "PRODUCT" | "UNKNOWN";

export type VariantFinance = {
  financialType: FinancialItemType | null;      // null = ITEM_UNCLASSIFIED
  financialTypeSource: EffectiveSource;
  includesVase: boolean | null;                 // null = unknown
  includesVaseSource: EffectiveSource;
  /// Себестоимость вазы, применимая к этой позиции на дату. null = VASE_COST_MISSING.
  vaseCostCents: number | null;
  vaseCostType: VaseCostType | null;
  vaseCostSource: EffectiveSource;
  vaseCostRecordId: string | null;              // что именно применено — попадёт в CalcInput
  reviewReasons: ("ITEM_UNCLASSIFIED" | "VASE_COST_MISSING")[];
};

/**
 * Чистая функция. Ни Prisma, ни даты «сейчас» внутри: at передаётся снаружи —
 * это дата доставки заказа в таймзоне магазина.
 */
export function resolveVariantFinance(input: {
  variant: { financialType: FinancialItemType | null; includesVase: boolean | null };
  product: { financialType: FinancialItemType | null; defaultIncludesVase: boolean | null };
  costs: VasePurchaseCostRow[];   // все строки по варианту и товару, любых costType
  at: Date;
}): VariantFinance;
```

Правила внутри — ровно те, что согласованы:

* тип: вариант → товар → `null`;
* `includesVase`: вариант → товар → `null`;
* **effective type = VASE** → берётся `STANDALONE_VASE`; `includesVase` не участвует;
* **FLOWER_PRODUCT + includesVase = true** → берётся `INCLUDED_VASE`: сначала вариант, потом товар;
  `STANDALONE_VASE` для букета не применяется никогда;
* **includesVase = false** → стоимость не применяется вообще, даже если запись `INCLUDED_VASE`
  существует; такие записи не удаляются;
* `listPrice` не читается — цена клиента себестоимостью не становится ни в одной ветке.

## 6. `setVasePurchaseCost`

```ts
export async function setVasePurchaseCost(args: {
  target: { productId: string } | { productVariantId: string };
  costType: VaseCostType;
  purchaseCostCents: number;        // >= 0
  effectiveFrom: Date;
  actor: { userId: string; role: Role };
  reason?: string;                  // обязателен, когда batchId задан
  batchId?: string;
  comment?: string;
}): Promise<{ closedId: string | null; createdId: string }>;
```

Одна транзакция:

1. `SELECT … FOR UPDATE` активного интервала цели и типа;
2. закрытие его `effectiveTo = effectiveFrom` нового (полуинтервал `[)` — зазор не нужен);
3. вставка новой строки;
4. запись `FinanceAudit` (before/after, автор, роль, причина, `batchId`, effective date).

Гонка невозможна: даже если две транзакции пройдут шаг 1 одновременно, вторую отклонит
exclusion-constraint — это проверено (см. §2, последняя строка таблицы). Сервис ловит
`23P01` и повторяет операцию один раз, после чего отдаёт понятную ошибку.
Integration-тест: параллельные вызовы на одну цель дают ровно один открытый интервал.

## 7. Пять примеров резолва

| # | Ситуация | Вход | Результат |
|---|---|---|---|
| 1 | Самостоятельная ваза | variant.type = VASE; `STANDALONE_VASE` $12 с 08-01 | type VASE, cost **$12.00**, source VARIANT, `includesVase` игнорируется |
| 2 | Букет с унаследованной вазой | variant.type = null, product.type = FLOWER_PRODUCT; variant.includesVase = null, product.defaultIncludesVase = true; `INCLUDED_VASE` $12 на товаре | type FLOWER_PRODUCT (PRODUCT), includesVase true (PRODUCT), cost **$12.00** (PRODUCT) |
| 3 | Override на варианте | то же + `INCLUDED_VASE` $26 на варианте | cost **$26.00**, source VARIANT — товарная строка не применяется |
| 4 | No Vase | variant.includesVase = false; на товаре есть `INCLUDED_VASE` $12 | includesVase false (VARIANT), cost **не применяется**, `VASE_COST_MISSING` не поднимается, историческая строка сохранена |
| 5 | Стоимость не задана | variant.type = VASE, записей нет | type VASE, cost **null**, `reviewReasons = [VASE_COST_MISSING]` → снимок заказа `PRELIMINARY` |

## 8. Откат и восстановление

**Откат до применения** — удалить каталог миграции; схема возвращается `git checkout prisma/schema.prisma`.

**Откат после применения** (данных нет, потому что backfill отсутствует):

```sql
BEGIN;
DROP TABLE "FinanceAudit";
DROP TABLE "VasePurchaseCost";          -- сначала таблицы: они держат enum
ALTER TABLE "ProductVariant"
  DROP COLUMN "financialType", DROP COLUMN "includesVase",
  DROP COLUMN "financialTypeSetBy", DROP COLUMN "financialTypeSetAt";
ALTER TABLE "Product"
  DROP COLUMN "financialType", DROP COLUMN "defaultIncludesVase";
DROP TYPE "VaseCostType";
DROP TYPE "FinancialItemType";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260801120000_catalog_finance_classification';
COMMIT;
-- расширение btree_gist не удаляем: оно безвредно и может использоваться дальше
```

Откат безопасен ровно до момента, когда владелец начал размечать каталог: после этого DROP
COLUMN уничтожит разметку, поэтому «починка» вместо отката — обычная новая миграция.

**Восстановление при частичном сбое.** Миграция идёт одной транзакцией (Prisma оборачивает
файл целиком), поэтому промежуточного состояния не остаётся. Единственный внешний риск —
`CREATE EXTENSION btree_gist`: он требует прав суперпользователя или расширения в списке
доверенных. Если на проде прав не хватит, миграция упадёт на первом шаге, ничего не изменив;
тогда расширение ставится администратором БД отдельной командой, после чего миграция
повторяется. Проверить заранее одним запросом:

```sql
SELECT * FROM pg_available_extensions WHERE name = 'btree_gist';
```
