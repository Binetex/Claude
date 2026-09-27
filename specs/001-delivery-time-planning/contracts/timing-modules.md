# Contract: модуль `modules/timing`

Чистые функции (без БД и «сейчас» — время передаётся параметром):

```ts
// model.ts
DEFAULT_MODEL: TimeModel
computeModel(samples: DeliverySample[], firstDispatch: FirstDispatchSample[], florists: { id; workStartMin }[], now: Date): TimeModel
driveMin(model, miles: number | null): number
prepMin(model, floristId: string | null, big: boolean): number
setupMin(model, floristId: string | null): number

// planner.ts
planDay(args: { start: number; jobs: PlanJob[]; model; floristId; allowEarlierStart: boolean }): Plan
canFit(args: { plan inputs…; job: PlanJob }): { ok: boolean; eta: number; plan: Plan }
earliestBy(args: { plan inputs…; job: Omit<PlanJob, "deadline"> }): number   // минимальный срок, при котором влезает

// policy.ts
decideTime(input: {
  isToday: boolean; nowMin: number;
  extracted: ExtractedTime | null;      // из сообщения
  known: CustomerTime | null;           // что уже знаем
  window: WindowRange | null;           // обещание
  canBy: (until: number) => boolean;    // расписание: успеем ли до
  earliest: number;                     // самое раннее возможное время доставки
  blocked: string | null;               // причина «только человек» (курьер вызван, не сторона заказа…)
}): TimeDecision
agreeFromMin(d: TimeDecision, fallback: number): number
windowAfter(d: TimeDecision, window: WindowRange | null, known: CustomerTime | null): WindowRange | null
```

Серверные (`stats.ts`, `load.ts`):

```ts
loadTimeModel(prisma): Promise<TimeModel>              // кэш 6 ч
floristDayPlan(prisma, floristId, day, now): Promise<Plan & { florist… }>
orderTiming(prisma, orderId, now): Promise<{ floristId; plan; earliest; canBy(until) } | null>
siteOutlook(prisma, siteId, day, now): Promise<{ earliest: number; canBy(until) } | null>
```
