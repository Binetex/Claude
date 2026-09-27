# Data Model: Планирование времени доставки

Все времена — минуты от полуночи по часам магазина (Лос-Анджелес). День — «YYYY-MM-DD» (как в
`Order.deliveryDate`). Новых колонок в этой фиче нет.

## Order (без изменений)

| Поле | Тип | Смысл |
|---|---|---|
| `windowFrom`, `windowTo` | Int? | обещание магазина «с — до»; сюда же ассистент пишет подтверждённое клиенту время |
| `customerNote` | String | слова клиента о времени — строкой «готов принять …» (как раньше) |

## Florist

| Поле | Тип | Смысл |
|---|---|---|
| `workStartMin` | Int? | начало работы (добавлено 28.09); NULL → 10:00. Настя 600, Ольга 720; правится в «Флористах» |
| `morningCapacity` | Int | больше не читается (баллы утра удалены); колонка снимается отдельным деплоем |

## TimeModel (вычисляется, не хранится; `timing/model.ts`)

```ts
{
  courierMin: number;                                   // ожидание курьера, p80
  drive: { fromMiles; toMiles; min }[];                 // дорога p80 по корзинам расстояния
  unknownDriveMin: number;                              // адрес/место неизвестны
  prep: Record<floristId, { small; big }>;              // сборка, медиана
  prepDefault: { small; big };
  setup: Record<floristId, number>;                     // подготовка к первому букету дня
  setupDefault: number;
  sample: { deliveries; since; computedAt; measured };
}
```

## PlanJob / PlanItem / Plan (расписание; `timing/planner.ts`)

```ts
PlanJob  = { id; big; deadline; windowFrom; driveMin; fixed? }   // fixed — готов/в пути/доставлен
PlanItem = PlanJob & { seq: number | null; readyAt; etaAt; lateMin; risk }
Plan     = { lineStart; items }
```

## Самое раннее время (`timing/load.ts`)

`number` — минута, к которой успеваем; `null` — в этот день уже не успеть; `undefined` — судить не
по чему (нет флориста). Одна цифра и для текста модели, и для проверки ответа (`agreeFromMin`).
