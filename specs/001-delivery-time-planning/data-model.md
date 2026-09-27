# Data Model: Планирование времени доставки

Все времена — минуты от полуночи по часам магазина (Лос-Анджелес). День — «YYYY-MM-DD» (как в
`Order.deliveryDate`).

## Order (изменение)

| Поле | Тип | Смысл |
|---|---|---|
| `windowFrom`, `windowTo` | Int? | (есть) обещание магазина «с — до» |
| `customerTime` | Json? | **новое**: что клиент сказал о своём времени (см. CustomerTime) |

## Florist (изменение)

| Поле | Тип | Смысл |
|---|---|---|
| `workStartMin` | Int? | (есть с 28.09) начало работы; NULL → 10:00. Настя 600, Ольга 720 |
| `morningCapacity` | Int | устаревает (клетки убираются); колонка остаётся до отдельной чистки |

## CustomerTime (JSON в `Order.customerTime`)

```ts
{
  day: string;          // к какому дню доставки относится («2026-09-28»)
  from: number | null;  // может принять с
  until: number | null; // может принять до (крайний срок)
  altFrom: number | null;  // запасной промежуток, если основной не подошёл
  altUntil: number | null;
  anytime: boolean;     // «в любое время»
  source: "sms" | "owner";
  at: string;           // ISO, когда обновлено
}
```

Правила: `from < until`, `altFrom < altUntil`; значения 0–1440. Слияние: новое сообщение заменяет
только названные поля; сообщение про другой день начинает запись заново. Устаревает, когда день
доставки заказа меняется на другой (относится к `day`).

## TimeModel (вычисляется, не хранится)

```ts
{
  courierMin: number;                 // ожидание курьера, p80
  driveBuckets: { miles: number; min: number }[];  // p80 по серединам корзин
  unknownDriveMin: number;            // адрес/место неизвестны
  prep: Record<floristId, { small: number; big: number }>;  // медиана сборки
  prepDefault: { small: number; big: number };
  setup: Record<floristId, number>;   // «разгон» первого букета дня
  setupDefault: number;
  sample: { deliveries: number; since: string; computedAt: string };
}
```

## PlanJob / PlanItem (расписание, вычисляется)

```ts
PlanJob  = { id; big: boolean; deadline: number; windowFrom: number; driveMin: number; fixed?: boolean }
PlanItem = PlanJob & { order: number; readyAt: number; etaAt: number; lateMin: number; risk: boolean }
Plan     = { start: number; items: PlanItem[] }
```

`fixed` — букет уже готов/в пути/доставлен: в очередь сборки не входит.

## TimeDecision (решение по разговору, вычисляется)

```ts
| { kind: "NONE" }
| { kind: "ASK_UNTIL" }
| { kind: "CONFIRM_BY"; until: number }
| { kind: "ASK_ALT"; until: number; earliest: number }
| { kind: "CONFIRM_FROM"; from: number }
| { kind: "CONFIRM_ANYTIME" }
| { kind: "CONFIRM_AT"; at: number }
| { kind: "HUMAN"; reason: string }
```

Каждое решение даёт `agreeFromMin` — раньше какого часа соглашаться нельзя (проверка ответа), и
запись в заказ (новое окно и/или время клиента).
