# Stage 1 — проект финансового ядра (на согласование)

Документ, а не реализация. Миграции нет, `prisma/schema.prisma` не изменён.
Схема — [schema-draft.prisma](./schema-draft.prisma).

---

## 0. Статус согласования

**Подтверждено владельцем (архитектура зафиксирована, не переигрывать):**

- отдельная `revision` на каждый пересчёт; `calcVersion` (версия алгоритма) — отдельно от `revision`;
- `CalcInput` хранится целиком внутри ревизии;
- опубликованные ревизии и их строки не изменяются содержательно и не удаляются;
- `LedgerEntry` — append-only;
- неизвестное значение не считается подтверждённым нулём;
- `ownerActualProfit = null`, если нет обязательных фактических данных;
- оценка показывается отдельно и всегда называется оценкой;
- DTO OWNER / PRIMARY / SECONDARY разделены физически.

**Классификация ваз — правило A (подтверждено):**

Позиция НЕ становится `VASE` только потому, что в названии есть слово «Vase».

Отдельная ваза как самостоятельный товар (пример: `Clear Glass Cylinder Vase 7 1/2 in`):
- `financialType = VASE`;
- вклад в базу распределения цветов = 0;
- стоимость вазы берётся из варианта либо из ручного значения;
- определяется явной классификацией Product/ProductVariant, а не разбором названия.

**Ожидает решения владельца:**
- правило для букета С вазой (`«… & Vase - …»`, `includesVase`);
- правило для букета БЕЗ вазы (`«… No Vase»`);
- правило для подарочных позиций (`Ferrero Rocher`, `Rosy Love Balloon` и подобных → `GIFT`);
- подтверждение состава расчётной выручки в §11 (позиции + доставка + собранный налог,
  с полным вычетом налога строкой Tax Reserve).

---

## 2. Жизненный цикл снимка и гарантии неизменяемости

### Состояния

```
        создание пересчёта
              ↓
          [DRAFT]  ← единственное состояние, где ревизию можно удалить
              ↓ publish()
    [PRELIMINARY] ──────────────┐  не хватает обязательных фактических данных
              ↓ finalize()      │
          [FINAL]               │  все обязательные компоненты известны
              ↓ closePeriod()   │
          [LOCKED] ←────────────┘  период закрыт; правки — только новой ревизией
```

Переход к новому расчёту НЕ меняет старую ревизию: создаётся `revision + 1`, а у предыдущей
проставляется `supersededAt`. Указатель `Order.currentFinancialSnapshotId` переключается на новую.
UI всегда читает только current revision.

### Что неизменяемо навсегда

`calcInputJson`, `inputHash`, `calcVersion`, `revision`, `reason`, все `OrderFinancialLine`
(суммы, классификация, источники, видимость, override-метаданные), результирующие суммы,
денормализованные снимки имён.

### Что разрешено менять

Ровно четыре поля: `status`, `finalizedAt`, `lockedAt`, `supersededAt`. Любое изменение пишется
в `FinanceAudit` с before/after.

### Защита на уровне БД (raw SQL внутри миграции Stage 1)

```sql
-- 1. Опубликованную ревизию нельзя удалять, а менять можно только lifecycle-поля.
CREATE OR REPLACE FUNCTION finance_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'published snapshot revision % of order % cannot be deleted',
        OLD.revision, OLD."orderId";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."publishedAt" IS NOT NULL THEN
    -- Разрешены к изменению только четыре поля жизненного цикла.
    IF (to_jsonb(NEW) - 'status' - 'finalizedAt' - 'lockedAt' - 'supersededAt')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'status' - 'finalizedAt' - 'lockedAt' - 'supersededAt') THEN
      RAISE EXCEPTION 'published snapshot revision % is immutable; create a new revision',
        OLD.revision;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_finance_snapshot_guard
  BEFORE UPDATE OR DELETE ON "OrderFinancialSnapshot"
  FOR EACH ROW EXECUTE FUNCTION finance_snapshot_guard();

-- 2. Строки опубликованной ревизии неизменяемы целиком.
CREATE OR REPLACE FUNCTION finance_line_guard() RETURNS trigger AS $$
DECLARE published TIMESTAMP;
BEGIN
  SELECT "publishedAt" INTO published FROM "OrderFinancialSnapshot"
   WHERE id = COALESCE(OLD."snapshotId", NEW."snapshotId");
  IF published IS NOT NULL THEN
    RAISE EXCEPTION 'lines of a published snapshot are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_finance_line_guard
  BEFORE UPDATE OR DELETE ON "OrderFinancialLine"
  FOR EACH ROW EXECUTE FUNCTION finance_line_guard();

-- 3. Ledger: append-only без исключений.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only: use a reversal or correction entry';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_append_only
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
```

Сервисный слой дублирует эти правила понятными ошибками (триггер — последняя линия обороны,
а не единственная). Integration-тесты: попытка UPDATE/DELETE опубликованной ревизии, её строк
и записи ledger обязаны падать; удаление DRAFT без ссылок — проходить; удаление DRAFT, на который
ссылается `Order.currentFinancialSnapshotId`, — падать.

---

## 3. Пример CalcInput JSON

Сохраняется в `calcInputJson` целиком: по нему старую ревизию можно пересчитать спустя год.

```json
{
  "calcVersion": "finance-v1",
  "builtAt": "2026-09-03T18:04:11.402Z",
  "order": {
    "id": "cms9ew8x600bc7fmll6xfk2fj",
    "orderNumber": "FLWBR-91157",
    "siteId": "cmr...flwbr",
    "siteShortName": "FLWBR",
    "platform": "SHOPIFY",
    "deliveryDate": "2026-07-31",
    "businessTimezone": "America/Los_Angeles",
    "orderStatus": "DELIVERED",
    "paymentStatus": "PAID",
    "financeEligibility": "INCLUDED",
    "floristId": "cmruuzsob000999mljzqdvkre",
    "floristNameSnapshot": "Настя",
    "floristFinanceModel": "SECONDARY",
    "priceMode": "MANUAL"
  },
  "money": {
    "itemsTotalCents": 17000,
    "taxCents": 1775,
    "tipCents": 1700,
    "discountCents": 0,
    "deliveryCustomerCents": 1500,
    "customerTotalCents": 21975,
    "floristTotalStoredCents": 13500
  },
  "items": [
    { "id": "cms9ew8xv00bd", "name": "Ranunculus & Hydrangea Refined Bloom Bouquet",
      "financialType": "FLOWER_PRODUCT", "classificationSource": "OWNER_RULE",
      "quantity": 1, "customerCents": 16900, "floristCents": 11830,
      "variantId": "cmrqei08f005vj6mlstg7t2kp", "includesVase": false, "vaseCostCents": null },
    { "id": "cms9ew8xv00be", "name": "Personal Note + Envelope",
      "financialType": "CARD", "classificationSource": "OWNER_RULE",
      "quantity": 1, "customerCents": 100, "floristCents": 70 },
    { "id": "cms9ew8xv00bf", "name": "Tip",
      "financialType": "TIP", "classificationSource": "PLATFORM_METADATA",
      "quantity": 1, "customerCents": 1700, "floristCents": 0 }
  ],
  "payments": [
    { "id": "ptx_1", "type": "PAYMENT", "provider": "SHOPIFY_PAYMENTS",
      "grossCents": 21975, "feeActualCents": null, "feeEstimatedCents": 667,
      "feeStatus": "ESTIMATED", "source": "ESTIMATED", "verificationStatus": "ESTIMATED" }
  ],
  "delivery": { "provider": "BURQ", "actualCostCents": 1449, "source": "API_ACTUAL",
                "verificationStatus": "VERIFIED" },
  "refunds": [],
  "appliedSettings": [
    { "key": "PRIMARY_SHARE_PERCENT", "id": "set_a1", "effectiveFrom": "2026-09-01", "value": "66.6" },
    { "key": "TAX_OWNER_SHARE_PERCENT", "id": "set_b2", "effectiveFrom": "2026-09-01", "value": "80" },
    { "key": "SUPPLIES_PER_ORDER_CENTS", "id": "set_c3", "effectiveFrom": "2026-09-01", "value": "500" }
  ],
  "appliedProviderFee": { "id": "fee_shopify_flwbr", "provider": "SHOPIFY_PAYMENTS",
                          "scopeKey": "cmr...flwbr:*", "percent": "2.9", "fixedCents": 30,
                          "effectiveFrom": "2026-09-01" },
  "flowerAllocation": { "dailyExpenseId": "dfe_2026_07_31", "expenseDate": "2026-07-31",
                        "dayTotalCents": 35000, "dayFlowerBaseCents": 70000,
                        "orderFlowerRevenueCents": 16900, "allocatedCents": 8450,
                        "method": "PROPORTIONAL_FLOWER_REVENUE" },
  "expenseCategories": [
    { "id": "cat_callcenter", "code": "CALL_CENTER", "allocationLevel": "ORDER",
      "calcMethod": "FIXED_PER_ORDER", "calcValue": "200", "visibility": "ALL_FLORISTS" }
  ]
}
```

---

## 4. Обычный заказ

Букет $169.00, цена флориста $118.30, доставка клиенту $15.00, налог $17.75, чаевых нет,
комиссия Shopify Payments 2.9% + $0.30, фактическая доставка Burq $14.49, расходники $5.00,
цветы за день распределены пропорционально.

| Строка | kind | visibility | calculated | actual | source |
|---|---|---|---|---|---|
| ITEM_REVENUE | REVENUE | ALL_FLORISTS | $169.00 | — | DERIVED |
| DELIVERY_REVENUE | REVENUE | ALL_FLORISTS | $15.00 | — | DERIVED |
| TAX_COLLECTED | REVENUE | ALL_FLORISTS | $17.75 | — | PLATFORM_REPORTED |
| TAX_RESERVE | RESERVE | ALL_FLORISTS | $17.75 | — | DERIVED |
| PAYMENT_FEE | ACTUAL_EXPENSE | ALL_FLORISTS | $6.16 | null | ESTIMATED |
| DELIVERY_COST | ACTUAL_EXPENSE | ALL_FLORISTS | $14.49 | $14.49 | API_ACTUAL |
| FLOWER_COST_ALLOCATED | ALLOCATION | ALL_FLORISTS | $84.50 | — | ALLOCATED |
| VASE_COST | ACTUAL_EXPENSE | ALL_FLORISTS | $0.00 | $0.00 | DERIVED |
| SUPPLIES | ALLOCATION | ALL_FLORISTS | $5.00 | — | DERIVED |
| SECONDARY_FLORIST_COST | ACTUAL_EXPENSE | ALL_FLORISTS | $118.30 | $118.30 | MANUAL |
| CALL_CENTER | ALLOCATION | ALL_FLORISTS | $2.00 | $0.00 | ALLOCATED |
| TAX_ACTUAL_LIABILITY | ACTUAL_EXPENSE | **OWNER_ONLY** | $3.55 | null | ESTIMATED |
| TAX_OWNER_INCOME | OWNER_COMPENSATION | **OWNER_ONLY** | $14.20 | — | DERIVED |

Распределяемая база: `169.00 + 15.00 + 17.75 − (17.75 + 6.16 + 14.49 + 84.50 + 0 + 5.00 + 118.30 + 2.00)` = **−$46.45**.
Отрицательная — по D1 доля основного флориста = 0, убыток видит владелец.
`ownerActualProfitCents = null`: фактическая комиссия неизвестна → `PAYMENT_FEE_MISSING`, статус `PRELIMINARY`.
`ownerProfitEstimateCents` считается и явно называется оценкой.

---

## 5. Заказ с Shopify tip-item — FLWBR-91157

Ключевое: чаевые **не входят** ни в один расход и ни в распределяемую базу; в доход они не
попадают вовсе, а уходят строкой owner-only.

| Строка | kind | visibility | calculated |
|---|---|---|---|
| ITEM_REVENUE | REVENUE | ALL_FLORISTS | $170.00 |
| DELIVERY_REVENUE | REVENUE | ALL_FLORISTS | $15.00 |
| TAX_COLLECTED / TAX_RESERVE | REVENUE / RESERVE | ALL_FLORISTS | $17.75 / $17.75 |
| SECONDARY_FLORIST_COST | ACTUAL_EXPENSE | ALL_FLORISTS | **$119.00** |
| **TIP_OWNER_INCOME** | OWNER_COMPENSATION | **OWNER_ONLY** | **$17.00** |

Проверки, зашитые в тесты: строка Tip имеет `financialType = TIP` и `floristCents = 0`;
`SECONDARY_FLORIST_COST` = 0.70 + 118.30 = $119.00; чаевые встречаются в снимке ровно один раз
(из `Order.tip`, позиция-Tip в `ITEM_REVENUE` не входит — у Shopify она вне `subtotal_price`,
подтверждено на 43 из 43 заказов).

---

## 6. Заказ с вазой внутри букета

Позиция «Apricot & Vase - Clear Glass Vase 8 in», $195.00, вариант помечен
`includesVase = true`, `vaseCostCents = 1200`.

| Строка | calculated | source | комментарий |
|---|---|---|---|
| ITEM_REVENUE | $195.00 | DERIVED | ваза внутри цены букета, отдельной выручки нет |
| FLOWER_REVENUE_BASE | $183.00 | DERIVED | 195.00 − 12.00: база распределения цветов очищена от вазы |
| VASE_COST | $12.00 | MANUAL | из `ProductVariant.vaseCostCents` |

Если `vaseCostCents = null`: `VASE_COST.calculatedCents = null`, `source = MISSING`,
`verificationStatus = MISSING`, `reviewReasons += VASE_COST_MISSING`, статус `PRELIMINARY`,
`FLOWER_REVENUE_BASE` = полная цена позиции (занижать базу на неизвестную величину нельзя).
Ручной override на заказе имеет приоритет над полем варианта.

---

## 7. Заказ с неизвестной доставкой — итог null, а не завышенное число

Тот же заказ, что в §4, но доставка выполнена не через Burq: фактическая стоимость неизвестна,
оценки нет.

```json
{
  "lines": [
    { "code": "DELIVERY_COST", "calculatedCents": null, "actualCents": null,
      "source": "MISSING", "verificationStatus": "MISSING" }
  ],
  "needsReview": true,
  "reviewReasons": ["DELIVERY_COST_MISSING", "PAYMENT_FEE_MISSING"],
  "status": "PRELIMINARY",
  "distributableProfitCents": null,
  "distributableCompleteness": "INCOMPLETE",
  "ownerActualProfitCents": null,
  "ownerActualCompleteness": "INCOMPLETE",
  "ownerProfitEstimateCents": 3855
}
```

В интерфейсе: «Реальная прибыль owner — **не рассчитана**» и рядом «Предварительная оценка: $38.55».
Числа `$38.55` в колонке «Owner Actual Profit» не будет никогда. На уровне периода правило то же:
если хотя бы один включённый заказ `INCOMPLETE`, месячная реальная прибыль тоже `null`, и рядом
показывается, сколько заказов мешают её посчитать.

Обязательные для `COMPLETE` компоненты: фактическая комиссия провайдера, фактическая стоимость
доставки, суммы всех возвратов заказа, стоимость ваз, цена второстепенного флориста.

---

## 8. DTO владельца

```json
{
  "orderNumber": "FLWBR-91157",
  "snapshot": { "revision": 4, "calcVersion": "finance-v1", "status": "PRELIMINARY",
                "needsReview": true, "reviewReasons": ["PAYMENT_FEE_MISSING"] },
  "lines": [
    { "code": "TAX_RESERVE", "kind": "RESERVE", "calculated": 1775, "actual": null,
      "difference": null, "source": "DERIVED", "verificationStatus": "ESTIMATED" },
    { "code": "TAX_ACTUAL_LIABILITY", "kind": "ACTUAL_EXPENSE", "calculated": 355, "actual": null },
    { "code": "TAX_OWNER_INCOME", "kind": "OWNER_COMPENSATION", "calculated": 1420 },
    { "code": "TIP_OWNER_INCOME", "kind": "OWNER_COMPENSATION", "calculated": 1700 },
    { "code": "CALL_CENTER", "kind": "ALLOCATION", "calculated": 200, "actual": 0, "difference": 200 },
    { "code": "PAYMENT_FEE", "kind": "ACTUAL_EXPENSE", "calculated": 667, "actual": null }
  ],
  "results": { "distributableProfit": null, "ownerActualProfit": null,
               "ownerActualCompleteness": "INCOMPLETE", "ownerProfitEstimate": 3855,
               "ownerOnlyIncome": 3120, "secondaryAccrual": 11900 }
}
```

## 9. DTO основного флориста

```json
{
  "orderNumber": "FLWBR-91157",
  "lines": [
    { "code": "ITEM_REVENUE", "label": "Выручка по позициям", "calculated": 17000 },
    { "code": "TAX_RESERVE", "label": "Tax Reserve", "calculated": 1775,
      "description": "Полный налог, собранный с клиента, резервируется до распределения прибыли." },
    { "code": "PAYMENT_FEE", "label": "Комиссия платёжной системы", "calculated": 667 },
    { "code": "DELIVERY_COST", "label": "Доставка", "calculated": 1449 },
    { "code": "FLOWER_COST_ALLOCATED", "label": "Цветы", "calculated": 8450 },
    { "code": "SUPPLIES", "label": "Расходники", "calculated": 500 },
    { "code": "SECONDARY_FLORIST_COST", "label": "Оплата флористу", "calculated": 11900 },
    { "code": "CALL_CENTER", "label": "Call Center Operations", "calculated": 200,
      "description": "Customer support, order changes, delivery coordination and communication with customers." }
  ],
  "results": { "distributableProfit": null, "distributableCompleteness": "INCOMPLETE" }
}
```

Строк `TAX_ACTUAL_LIABILITY`, `TAX_OWNER_INCOME`, `TIP_OWNER_INCOME` в ответе нет: они отсечены
условием `visibility IN ('ALL_FLORISTS','PRIMARY_FLORIST')` **в SQL-запросе**. Ключа `actual`
в объекте строки нет вообще — DTO строится отдельным билдером, а не фильтрацией готового объекта.

## 10. DTO второстепенного флориста

```json
{
  "orderNumber": "FLWBR-91157",
  "myAccrual": { "floristPrice": 11900, "status": "DELIVERED", "ledgerEntryId": "led_88" },
  "orderEconomics": [
    { "code": "TAX_RESERVE", "label": "Tax Reserve", "calculated": 1775,
      "description": "Полный налог, собранный с клиента." },
    { "code": "PAYMENT_FEE", "label": "Комиссия платёжной системы", "calculated": 667 },
    { "code": "DELIVERY_COST", "label": "Доставка", "calculated": 1449 },
    { "code": "FLOWER_COST_ALLOCATED", "label": "Цветы", "calculated": 8450 },
    { "code": "VASE_COST", "label": "Ваза", "calculated": 0 },
    { "code": "SUPPLIES", "label": "Расходники", "calculated": 500 },
    { "code": "CALL_CENTER", "label": "Call Center Operations", "calculated": 200,
      "description": "Customer support, order changes, delivery coordination and communication with customers." }
  ],
  "note": "Экономика заказа показана информационно и не влияет на ваше начисление."
}
```

Доказательство ограничений (проверяется тестом, который сериализует заказ со ВСЕМИ заполненными
owner-полями и сравнивает набор ключей):

* видимые расчётные расходы присутствуют — `orderEconomics` непустой, включает Tax Reserve,
  комиссии, доставку, цветы, вазы, расходники, call-center;
* физически отсутствуют ключи: `actual`, `actualCents`, `difference`, `ownerActualProfit`,
  `ownerOnlyIncome`, `taxOwnerShare`, `taxActualLiability`, `tipOwnerIncome`,
  `distributableProfit`, `primaryFloristShare`;
* начисление берётся из ledger (`myAccrual`), а не из `orderEconomics`.

---

## 11. Месячный расчёт основного флориста

Период: MONTH, `America/Los_Angeles`, 2026-09-01 … 2026-09-30, база — доставленные заказы
с `financeEligibility = INCLUDED` по всем магазинам.

| Статья | Сумма |
|---|---:|
| Выручка по позициям | $10 000.00 |
| Выручка за доставку | $600.00 |
| Налог, собранный с клиентов | $1 000.00 |
| **Расчётная выручка** | **$11 600.00** |
| Tax Reserve | −$1 000.00 |
| Комиссии платёжных систем | −$340.00 |
| Доставка (факт) | −$520.00 |
| Цветы | −$2 799.00 |
| Вазы | −$300.00 |
| Расходники | −$600.00 |
| Оплата второстепенным флористам | −$1 500.00 |
| Call Center Operations | −$600.00 |
| Administration | −$400.00 |
| **Расчётные расходы** | **−$8 059.00** |
| **Распределяемая прибыль** | **$3 541.00** |

Доля 66.6%: `354100 × 0.666 = 235 830.6` цента → флористу **$2 358.30** (округление вниз),
владельцу `354100 − 235830 = $1 182.70`. Остаточные 0.6 цента остаются владельцу — правило D5.

Чаевые ($500.00 за месяц) в таблице отсутствуют: они не входят ни в выручку, ни в базу.
Owner-only доход считается отдельно: чаевые $500.00 + 80% налога $800.00 + разница
расчётных и фактических статей (Call Center $600.00 − $0.00, Administration $400.00 − $250.00).

Начисление в ledger: одна запись `PRIMARY_FLORIST_SHARE` на период,
`idempotencyKey = "period:{periodId}:primary:{profileId}:v1"`, направление CREDIT.

Если распределяемая прибыль отрицательная — по D1 начисление не создаётся вообще (не ноль-запись),
владелец видит убыток периода, `CARRY_FORWARD` не используется.

---

## 12. Dry-run классификации: все 383 позиции

Прогон по предложенному приоритету на боевых данных (read-only).

| Источник разрешения | Позиций |
|---|---:|
| PLATFORM_METADATA | 0 — сырые properties/gift_card не сохраняются при импорте |
| SKU | 0 — SKU почти везде пуст |
| PRODUCT_TYPE | 0 — см. ниже |
| OWNER_RULE | 0 — правил ещё нет |
| Сопоставление с каталогом (товар по умолчанию) | 141 |
| NAME_FALLBACK | 140 |
| **Не классифицировано** | **102** |

### Три находки, меняющие план

**1. `Product.productType` бесполезен.** Значения в каталоге: `null` (275), `simple` (168),
`variable` (145) — это типы товаров WooCommerce, а не категории. Приоритет «сохранённый тип
товара» придётся наполнять своим полем `financialType` на Product/ProductVariant, а не брать
из платформы.

**2. Классификация ваз по имени опасна.** Реальные названия:

| Название | Цена | Что это на самом деле |
|---|---:|---|
| `Clear Glass Cylinder Vase 7 1/2 in` | $40.00 | настоящая VASE-позиция |
| `Apricot & Vase - Clear Glass Vase 8 in` | $195.00 | букет С вазой → `includesVase`, не VASE |
| `Sweet Kiss - Standard, No Vase` | $145.00 | букет БЕЗ вазы → FLOWER_PRODUCT |

Правило `name ~ 'vase'` пометило бы вазой 68 позиций, из которых верно меньшинство. Поэтому:
паттерн `«… & Vase - …»` → OWNER_RULE «букет с вазой» (`includesVase = true`),
паттерн `«… No Vase»` → OWNER_RULE «букет без вазы», и только точное совпадение с каталогом
ваз даёт `VASE`. Автоматически ничего из этого не проставляю — нужны ваши правила.

**3. 102 позиции без единого надёжного признака** — это букеты из заказов, не сопоставленных
с каталогом (`Clair de Bloom`, `Mon Amour`, `Blue Sky`, `Éden Rose`…). Плюс подарки внутри той же
группы (`Ferrero Rocher` ×3, `Rosy Love Balloon` ×2), которые обязаны стать `GIFT`, а не
`FLOWER_PRODUCT`, иначе они попадут в базу распределения расходов на цветы.

### Что предлагается сделать

1. Правила OWNER для трёх паттернов ваз и для подарочных позиций (chocolate/balloon/teddy/wine).
2. Проставить `financialType` на 923 вариантах каталога — один раз, отчётом с ручной проверкой.
3. Оставшиеся позиции без правила → `financialType = null` + `ITEM_UNCLASSIFIED` + `PRELIMINARY`.
   Не угадывать: непроклассифицированная позиция не попадает в базу распределения цветов и явно
   висит в списке «требует классификации».

---

## 13. Индексы, внешние ключи и политики удаления

### onDelete

| Связь | Политика | Почему |
|---|---|---|
| `OrderFinancialSnapshot.order` → Order | **Restrict** | финансовая история переживает заказ |
| `OrderFinancialSnapshot.period` → FinancePeriod | Restrict | нельзя удалить период с расчётами |
| `OrderFinancialLine.snapshot` → Snapshot | Cascade, но только для DRAFT | строки — часть ревизии; для опубликованной удаление запрещено триггером |
| `OrderFinancialLine.category` → ExpenseCategory | Restrict | категория с историей не удаляется |
| `LedgerEntry.florist` → Florist | Restrict | баланс не исчезает вместе с профилем |
| `LedgerEntry.order` → Order | Restrict | — |
| `LedgerEntry.period` → FinancePeriod | Restrict | — |
| `LedgerEntry.reversedEntry` → LedgerEntry | Restrict | цепочка исправлений неразрывна |
| `PaymentTransaction.order` → Order | Restrict | — |
| `RefundCase.order` → Order | Restrict | — |
| `DeliveryCompensation.order` / `.refundCase` | Restrict | — |
| `DailyFlowerExpense.profile` → FloristFinanceProfile | Restrict | — |
| `FloristFinanceProfile.florist` → Florist | Restrict | история договорённостей сохраняется |
| `FinanceProfileSite`, `ExpenseCategorySite`, `ExpenseCategoryFlorist` | Restrict | — |
| `PaymentProviderFee.site` → Site | Restrict | — |
| `FinanceAudit.user` → User | Restrict | автор действия не стирается |

Дополнительно каждая финансовая сущность хранит денормализованные снимки
(`orderNumberSnapshot`, `siteShortNameSnapshot`, `floristNameSnapshot`), чтобы отчёт оставался
читаемым, даже если связанная запись деактивирована.

### Индексы

| Модель | Индексы |
|---|---|
| OrderFinancialSnapshot | `@@unique([orderId, revision])`, `[orderId, createdAt]`, `[status, needsReview]`, `[periodId]` |
| OrderFinancialLine | `@@unique([snapshotId, code])`, `[code]`, `[categoryId]` |
| LedgerEntry | `idempotencyKey @unique`, `[floristId, effectiveDate]`, `[orderId]`, `[periodId]` |
| FinancePeriod | `@@unique([type, timezone, localStartDate, localEndDate])`, `[status, startsAtUtc]` |
| PaymentTransaction | `@@unique([provider, providerTransactionId])`, `[orderId, occurredAt]`, `[payoutId]` |
| PaymentProviderFee | `@@unique([provider, scopeKey, effectiveFrom])`, `[provider, effectiveFrom]` |
| DailyFlowerExpense | `@@unique([expenseDate, financeProfileId])`, `[expenseDate]` |
| FinanceSetting | `[key, effectiveFrom]` |
| ExpenseCategory | `[active, effectiveFrom]` |
| FloristFinanceProfile | `[floristId, effectiveFrom]`, `[model, active]` |
| ItemClassificationRule | `[siteId, active, priority]` |
| RefundCase / DeliveryCompensation | `[orderId]` |
| FinanceAudit | `[entity, entityId, createdAt]`, `[userId, createdAt]` |
| Order (новое) | `currentFinancialSnapshotId @unique`, `[financeEligibility]` |

Основной запрос дашборда — агрегат по `OrderFinancialLine` с join на снимок, отфильтрованный по
`periodId` и `status`, а не обход заказов: N+1 исключён по построению.
