import "server-only";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { applyAutoPriceSnapshot, recomputeEstimatedProfit } from "@/modules/pricing/service";
import { notifyFloristAssigned } from "@/integrations/notifications/telegram";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { onOrderDeliveryChangeSafe } from "@/integrations/delivery/burq/scheduleService";

/** Активные флористы сайта в порядке приоритета (position ↑). */
export async function getSitePriorityFloristIds(siteId: string): Promise<string[]> {
  const rows = await prisma.siteFloristPriority.findMany({
    where: { siteId, florist: { active: true, user: { active: true } } },
    orderBy: { position: "asc" },
    select: { floristId: true },
  });
  return rows.map((r) => r.floristId);
}

/**
 * Автоматически заполняет приоритет флористов для сайта, у которого он ещё не задан
 * (вызывается при подключении нового магазина — владелец не должен вручную настраивать
 * очерёдность для каждого нового сайта). Основные флористы (financeVisibility=FULL)
 * идут первыми (по дате создания), затем второстепенные — тоже по дате создания.
 * Если для сайта приоритеты уже есть — ничего не делает (не перезаписывает ручную настройку).
 */
export async function autoAssignSitePriorities(siteId: string): Promise<void> {
  const already = await prisma.siteFloristPriority.count({ where: { siteId } });
  if (already > 0) return;

  const florists = await prisma.florist.findMany({
    where: { active: true, user: { active: true } },
    orderBy: { createdAt: "asc" },
  });
  if (florists.length === 0) return;

  // Явная сортировка в коде (не через orderBy по enum в БД): порядковый номер
  // Postgres-enum — это порядок ОБЪЯВЛЕНИЯ значений в schema.prisma, а не алфавитный,
  // и полагаться на него как на семантику приоритета неочевидно и легко сломать
  // при рефакторинге enum. Основные (FULL) флористы — первыми, каждая группа — по дате создания.
  const sorted = [
    ...florists.filter((f) => f.financeVisibility === "FULL"),
    ...florists.filter((f) => f.financeVisibility === "MAKER_ONLY"),
  ];

  await prisma.siteFloristPriority.createMany({
    data: sorted.map((f, i) => ({ siteId, floristId: f.id, position: i })),
  });
}

/** Добавляет флориста в конец списка приоритетов сайта. Идемпотентно. */
export async function addSitePriority(siteId: string, floristId: string): Promise<void> {
  const existing = await prisma.siteFloristPriority.findUnique({
    where: { siteId_floristId: { siteId, floristId } },
  });
  if (existing) return;

  const last = await prisma.siteFloristPriority.findFirst({
    where: { siteId },
    orderBy: { position: "desc" },
  });
  await prisma.siteFloristPriority.create({
    data: { siteId, floristId, position: (last?.position ?? -1) + 1 },
  });
}

/**
 * Убирает флориста из приоритета сайта и перенормирует позиции оставшихся (0..n-1),
 * чтобы не оставалось дыр — они мешают @@unique([siteId, position]) при следующих
 * add/move.
 */
export async function removeSitePriority(siteId: string, floristId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.siteFloristPriority.deleteMany({ where: { siteId, floristId } });
    const remaining = await tx.siteFloristPriority.findMany({
      where: { siteId },
      orderBy: { position: "asc" },
    });
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].position !== i) {
        await tx.siteFloristPriority.update({ where: { id: remaining[i].id }, data: { position: i } });
      }
    }
  });
}

/**
 * Меняет местами позицию флориста с соседней (вверх/вниз). @@unique([siteId, position])
 * не deferrable, поэтому прямой обмен (A→B, B→A) конфликтует до коммита — используем
 * временную позицию -1, которая не встречается среди реальных позиций (0..n-1).
 */
export async function moveSitePriority(
  siteId: string,
  floristId: string,
  direction: "up" | "down"
): Promise<void> {
  const rows = await prisma.siteFloristPriority.findMany({ where: { siteId }, orderBy: { position: "asc" } });
  const idx = rows.findIndex((r) => r.floristId === floristId);
  if (idx === -1) return;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return;

  const a = rows[idx];
  const b = rows[swapIdx];
  await prisma.$transaction([
    prisma.siteFloristPriority.update({ where: { id: a.id }, data: { position: -1 } }),
    prisma.siteFloristPriority.update({ where: { id: b.id }, data: { position: a.position } }),
    prisma.siteFloristPriority.update({ where: { id: a.id }, data: { position: b.position } }),
  ]);
}

/**
 * Назначает основного флориста (по текущему приоритету) всем оплаченным, но ещё не
 * назначенным заказам сайта — например, сразу после того как владелец впервые
 * проставил приоритеты для сайта, подключённого раньше, чем появились флористы.
 * Переиспользует assignInitial (идемпотентен, сам проверяет приоритет).
 */
export async function assignPendingOrdersForSite(siteId: string): Promise<{ assigned: number }> {
  const pending = await prisma.order.findMany({
    where: { siteId, assignmentStatus: "UNASSIGNED", paymentStatus: "PAID", orderStatus: { notIn: TERMINAL_ORDER_STATUSES } },
    select: { id: true },
  });

  let assigned = 0;
  for (const order of pending) {
    await assignInitial(order.id);
    const updated = await prisma.order.findUnique({ where: { id: order.id }, select: { assignmentStatus: true } });
    if (updated?.assignmentStatus !== "UNASSIGNED") assigned++;
  }
  return { assigned };
}

/**
 * Первичное авто-назначение оплаченного заказа основному флористу сайта.
 * Идемпотентно: если у заказа уже есть активное назначение — ничего не делает.
 */
export async function assignInitial(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  // Идемпотентность: не переназначаем, если уже назначен/принят.
  if (order.currentFloristId || order.assignmentStatus !== "UNASSIGNED") return;

  const priority = await getSitePriorityFloristIds(order.siteId);
  const nextFloristId = priority[0];

  if (!nextFloristId) {
    // Флористов нет — оставляем без назначения, владелец увидит предупреждение.
    await prisma.order.update({
      where: { id: orderId },
      data: { assignmentStatus: "UNASSIGNED", orderStatus: "CONFIRMED" },
    });
    return;
  }

  await assignAndActivateFlorist(orderId, nextFloristId);
}

type AssignActivateOpts = { closePrevious?: "DECLINED" | "REASSIGNED"; manualTotal?: Prisma.Decimal | null };

/**
 * ЕДИНЫЙ путь назначения флориста с АВТО-ПРИНЯТИЕМ (заменяет старый assign+accept flow).
 * Используется assignInitial, handoffOrder, reassignManual и decline-reassign — чтобы не было
 * второго параллельного пути. Атомарно в одной транзакции:
 *   - (опц.) корректно закрыть прежнее активное назначение (DECLINED/REASSIGNED);
 *   - создать новое назначение сразу ACCEPTED (respondedAt = now — время авто-принятия);
 *   - Order.assignmentStatus = ACCEPTED, orderStatus = FLORIST_ACCEPTED, currentFloristId;
 *   - снимок цены (авто под нового флориста, либо ручной), пересчёт прибыли.
 * Side-effects (уведомление + перепланирование доставки) — РОВНО ОДИН РАЗ и только после успешной
 * транзакции; при ошибке транзакции ничего частично активного не остаётся.
 */
export async function assignAndActivateFlorist(orderId: string, floristId: string, opts: AssignActivateOpts = {}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (opts.closePrevious) {
      await tx.orderAssignment.updateMany({
        where: { orderId, state: { in: ["ASSIGNED", "ACCEPTED"] } },
        data: { state: opts.closePrevious, respondedAt: new Date() },
      });
    }
    // Свежий снимок цены под НОВОГО флориста (старые расходы/финданные не копируются), либо ручная цена.
    const useManual = opts.manualTotal != null;
    const total = useManual ? opts.manualTotal! : await applyAutoPriceSnapshot(tx, orderId, floristId);
    const priceMode = useManual ? "MANUAL" : "AUTO";
    const now = new Date();
    await tx.order.update({
      where: { id: orderId },
      data: { currentFloristId: floristId, assignmentStatus: "ACCEPTED", orderStatus: "FLORIST_ACCEPTED", priceMode, floristTotal: total },
    });
    await tx.orderAssignment.create({
      data: { orderId, floristId, state: "ACCEPTED", respondedAt: now, priceMode, floristTotalSnapshot: total },
    });
    await recomputeEstimatedProfit(tx, orderId);
  });
  // Строго один раз после успешной транзакции: уведомление + (пере)планирование доставки под флориста.
  await notifyFloristAssigned(floristId, orderId);
  await onOrderDeliveryChangeSafe(prisma, orderId);
}

/**
 * Флорист отказывается. Заказ передаётся следующему по приоритету
 * (исключая всех, кто уже отказался). Если никого нет — UNASSIGNED.
 */
export async function declineOrder(orderId: string, floristId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.currentFloristId !== floristId) return;
  // Авто-принятие: активное назначение теперь ACCEPTED (раньше ждало ASSIGNED) — разрешаем оба.
  if (!["ASSIGNED", "ACCEPTED"].includes(order.assignmentStatus)) return;

  // Фиксируем отказ текущего флориста (его назначение теперь ACCEPTED).
  await prisma.orderAssignment.updateMany({
    where: { orderId, floristId, state: { in: ["ASSIGNED", "ACCEPTED"] } },
    data: { state: "DECLINED", respondedAt: new Date() },
  });

  // Кого уже исключили (все отказы по этому заказу).
  const declined = await prisma.orderAssignment.findMany({
    where: { orderId, state: "DECLINED" },
    select: { floristId: true },
  });
  const excluded = new Set(declined.map((d) => d.floristId));

  const priority = await getSitePriorityFloristIds(order.siteId);
  const nextFloristId = priority.find((id) => !excluded.has(id));

  if (!nextFloristId) {
    // Все доступные отказались — оставляем без флориста, не гоняем по кругу.
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          currentFloristId: null,
          assignmentStatus: "UNASSIGNED",
          orderStatus: "CONFIRMED",
          floristTotal: new Prisma.Decimal(0),
          priceMode: "AUTO",
        },
      });
      await recomputeEstimatedProfit(tx, orderId);
    });
    // Флориста больше нет → пере-оценить (существующий uninitiated draft будет отменён/переждёт).
    await onOrderDeliveryChangeSafe(prisma, orderId);
    return;
  }

  await assignAndActivateFlorist(orderId, nextFloristId);
}

/**
 * Флорист ПЕРЕДАЁТ свой назначенный заказ выбранному активному флористу (замена «Отказаться»):
 * фиксирует свой отказ (DECLINED) и назначает выбранного (авто-цена + уведомление). Передать может
 * только текущий назначенный флорист и пока заказ активен (ASSIGNED/ACCEPTED). Цель — другой активный
 * флорист (active florist + active user). История прежних назначений сохраняется.
 */
export async function handoffOrder(
  orderId: string,
  fromFloristId: string,
  toFloristId: string
): Promise<{ ok: boolean; reason?: string }> {
  if (fromFloristId === toFloristId) return { ok: false, reason: "same_florist" };
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { currentFloristId: true, assignmentStatus: true } });
  if (!order) return { ok: false, reason: "order_not_found" };
  if (order.currentFloristId !== fromFloristId) return { ok: false, reason: "not_current_florist" };
  // Авто-принятие: передавать можно из активного состояния (ASSIGNED — легаси, ACCEPTED — новое).
  if (!["ASSIGNED", "ACCEPTED"].includes(order.assignmentStatus)) return { ok: false, reason: "not_assignable" };
  const target = await prisma.florist.findFirst({ where: { id: toFloristId, active: true, user: { active: true } }, select: { id: true } });
  if (!target) return { ok: false, reason: "target_unavailable" };

  // Один путь: закрыть прежнее (DECLINED) + назначить+активировать нового — атомарно, без дублей.
  await assignAndActivateFlorist(orderId, toFloristId, { closePrevious: "DECLINED" });
  return { ok: true };
}

/**
 * Ручное переназначение владельцем.
 * keepManualPrice=true и наличие ручной цены → сохраняем текущую сумму (MANUAL).
 * Иначе — авто-снимок цены нового флориста.
 */
export async function reassignManual(
  orderId: string,
  floristId: string,
  keepManualPrice: boolean
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;

  // Сохранить ручную цену прежнего расчёта, если так указано; иначе — авто-снимок под нового флориста.
  const manualTotal = keepManualPrice && order.priceMode === "MANUAL" ? order.floristTotal : null;
  // Единый путь: закрыть прежнее (REASSIGNED) + назначить+активировать нового (сразу ACCEPTED). Внутри —
  // notify + перепланирование доставки ровно один раз после успешной транзакции.
  await assignAndActivateFlorist(orderId, floristId, { closePrevious: "REASSIGNED", manualTotal });
}

/** Владелец задаёт ручную цену флориста для заказа (приоритетнее авто). */
export async function setManualFloristPrice(
  orderId: string,
  amount: number
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { floristTotal: new Prisma.Decimal(amount), priceMode: "MANUAL" },
    });
    await recomputeEstimatedProfit(tx, orderId);
  });
}

/** Флорист начинает работу. */
export async function startWork(orderId: string, floristId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.currentFloristId !== floristId) return;
  if (order.assignmentStatus !== "ACCEPTED") return;
  await prisma.order.update({
    where: { id: orderId },
    data: { orderStatus: "IN_PROGRESS" },
  });
}

/** Флорист помечает готовность (фото не обязательно). */
export async function markReady(
  orderId: string,
  floristId: string,
  bouquetPhotoUrl?: string
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.currentFloristId !== floristId) return;
  if (!["IN_PROGRESS", "FLORIST_ACCEPTED"].includes(order.orderStatus)) return;
  await prisma.order.update({
    where: { id: orderId },
    data: {
      orderStatus: "READY",
      readyAt: new Date(),
      ...(bouquetPhotoUrl ? { bouquetPhotoUrl } : {}),
    },
  });
}

/** Флорист задаёт время готовности. */
export async function setReadyAt(
  orderId: string,
  floristId: string,
  readyAt: Date
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.currentFloristId !== floristId) return;
  await prisma.order.update({ where: { id: orderId }, data: { readyAt } });
}
