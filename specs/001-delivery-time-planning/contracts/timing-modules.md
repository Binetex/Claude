# Contract: модуль `modules/timing` и точки ассистента

Чистые функции (без БД и «сейчас» — время передаётся параметром):

```ts
// model.ts
DEFAULT_MODEL: TimeModel
computeModel({ deliveries, prep, firstDispatch, workStart, since, computedAt }): TimeModel
driveMin(model, miles: number | null): number
prepMin(model, floristId: string, big: boolean): number
setupMin(model, floristId: string): number

// planner.ts
planDay(jobs: PlanJob[], p: PlanParams): Plan
canFit(jobs: PlanJob[], job: PlanJob, p: PlanParams): { ok: boolean; etaAt: number | null }
earliestBy(jobs: PlanJob[], job: Omit<PlanJob, "deadline">, p: PlanParams): number | null
// PlanParams = { lineStart; courierMin; prepMin(big); earliestLineStart? }  (заранее — не раньше 6:00)
```

Серверные:

```ts
// stats.ts
loadTimeModel(prisma, now?): Promise<TimeModel>                       // кэш 6 ч; сбой → DEFAULT_MODEL
// load.ts
orderEarliest(prisma, orderId, now?): Promise<number | null | undefined>
siteEarliest(prisma, siteId, day, now?): Promise<number | null | undefined>
loadDaySchedule(prisma, day, now?): Promise<DaySchedule>              // очередь, плановое время, риск
```

Ассистент:

```ts
// prompt.ts
OrderSnapshot.earliest?: string | null            // «2:30 PM»; null — не успеть; нет поля — «4 PM (estimate)»
PromptInput.earliestNew?: { today?; tomorrow? }   // незнакомый номер
agreeFromMin(earliest: number | null | undefined): number
parseReply(raw, { agreeFromMin }): ParsedReply    // + confirmedFrom / confirmedUntil (минуты)
// JSON модели (бот с заказом): { …, "confirmed_from": "HH:MM"|null, "confirmed_until": "HH:MM"|null }

// reschedule.ts
confirmedWindow(current: WindowRange | null, c: { from; until }): WindowRange | null
planReschedule({ todayStr, currentDay, currentWindow, confirmed, newDate }): { day; window } | null
```
