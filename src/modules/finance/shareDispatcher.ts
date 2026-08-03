import "server-only";
/**
 * Ежедневный расчёт доли основного флориста в воркере.
 *
 * Отдельного планировщика нет: тот же интервал-диспетчер, что у начислений second-флористам
 * и у Airwallex. Считает и пересчитывает дни начиная с даты запуска — исторические не
 * трогает вовсе.
 *
 * Пересчёт НЕ трогает деньги: он переписывает итог дня, из которого выводится долг.
 * Реальная выплата появляется только ручной операцией PAYMENT от владельца, поэтому
 * автоматический пересчёт безопасен — он не может ничего «заплатить» по ошибке.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { primaryShareDays, recomputeDay } from "./dayFinance";
import { primaryShareGate } from "./config";

export type ShareDispatchResult = {
  days: number;
  /** Дни, которые посчитались целиком, — только они дают заработок. */
  complete: number;
  incomplete: number;
  reason?: string;
};

export async function dispatchPrimaryShare(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<ShareDispatchResult> {
  const gate = primaryShareGate();
  if (!gate.enabled) return { days: 0, complete: 0, incomplete: 0, reason: gate.reason };

  const plan = await primaryShareDays(now);
  if (!plan) return { days: 0, complete: 0, incomplete: 0, reason: "профиль или процент доли не заданы" };
  if (plan.days.length === 0) return { days: 0, complete: 0, incomplete: 0 };

  // Пересчёт дня подписывается владельцем: аноним в финансовых данных недопустим —
  // у каждой строки должен быть тот, кого можно спросить.
  const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, select: { id: true } });
  if (!owner) throw new Error("[finance] не найден активный OWNER — некому приписать пересчёт");
  const actor = { userId: owner.id, role: "OWNER" as const };

  let complete = 0;
  for (const day of plan.days) {
    const r = await recomputeDay(plan.profileId, day, actor);
    if (r?.complete) complete++;
  }

  return { days: plan.days.length, complete, incomplete: plan.days.length - complete };
}
