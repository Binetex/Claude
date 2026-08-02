import "server-only";
/**
 * Ежедневный расчёт доли основного флориста в воркере.
 *
 * Отдельного планировщика нет: тот же интервал-диспетчер, что у начислений second-флористам
 * и у Airwallex. Считает и пересчитывает дни начиная с даты запуска — исторические не
 * трогает вовсе.
 *
 * Начисление НЕ переводит деньги: оно показывает рассчитанный долг. Реальная выплата
 * появляется только ручной операцией PAYMENT от владельца, поэтому автоматический пересчёт
 * безопасен — он не может ничего «заплатить» по ошибке.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { backgroundActor } from "./accrual";
import { accrueDays, primaryShareDays } from "./primaryShare";
import { primaryShareGate } from "./config";

export type ShareDispatchResult = {
  days: number;
  created: number;
  corrected: number;
  unchanged: number;
  skipped: number;
  reason?: string;
};

export async function dispatchPrimaryShare(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<ShareDispatchResult> {
  const gate = primaryShareGate();
  if (!gate.enabled) {
    return { days: 0, created: 0, corrected: 0, unchanged: 0, skipped: 0, reason: gate.reason };
  }

  const plan = await primaryShareDays(now);
  if (!plan) {
    return { days: 0, created: 0, corrected: 0, unchanged: 0, skipped: 0, reason: "профиль или процент доли не заданы" };
  }
  if (plan.days.length === 0) return { days: 0, created: 0, corrected: 0, unchanged: 0, skipped: 0 };

  const actor = await backgroundActor();
  if (!actor) {
    // Автора записи не существует — это поломка конфигурации, а не бизнес-случай.
    throw new Error("[finance] не найден активный OWNER — некому приписать начисление доли");
  }

  const r = await accrueDays(plan.profileId, plan.days, actor);
  return { days: plan.days.length, ...r };
}
