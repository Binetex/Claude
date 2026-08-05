import "server-only";
/**
 * Пакетная загрузка настроек магазинов для расчёта.
 *
 * `resolveConsumablesRate` и `resolveFeeModel` ходят в базу за один магазин. Вызывать их
 * в цикле по заказам — по два запроса на заказ, тогда как магазинов во всей системе шесть.
 * Здесь то же самое берётся двумя запросами на любую выборку.
 *
 * Правила разрешения повторяют одиночные функции один в один: ставка магазина
 * приоритетнее глобальной, у комиссии глобальной модели не бывает.
 */
import { prisma } from "@/lib/db";
import type { ResolvedConsumables, ResolvedFeeModel } from "./settings";
import type { FinanceSettingsBySite } from "./orderInput";

export async function loadFinanceSettings(siteIds: string[]): Promise<FinanceSettingsBySite> {
  const consumables = new Map<string, ResolvedConsumables | null>();
  const feeModels = new Map<string, ResolvedFeeModel | null>();
  if (siteIds.length === 0) return { consumables, feeModels };

  const [rates, models] = await Promise.all([
    // Глобальная ставка (siteId = null) нужна как запасная для магазинов без своей.
    prisma.consumablesRate.findMany({
      where: { OR: [{ siteId: { in: siteIds } }, { siteId: null }] },
      select: { id: true, siteId: true, amountCents: true },
    }),
    prisma.siteAcquiringFeeModel.findMany({
      where: { siteId: { in: siteIds } },
      select: { id: true, siteId: true, percentBp: true, fixedCents: true },
    }),
  ]);

  const global = rates.find((r) => r.siteId === null);
  for (const siteId of siteIds) {
    const own = rates.find((r) => r.siteId === siteId);
    const pick = own ?? global;
    consumables.set(
      siteId,
      pick ? { amountCents: pick.amountCents, rateId: pick.id, scope: own ? "SITE" : "GLOBAL" } : null
    );

    const m = models.find((x) => x.siteId === siteId);
    feeModels.set(siteId, m ? { modelId: m.id, percentBp: m.percentBp, fixedCents: m.fixedCents } : null);
  }

  return { consumables, feeModels };
}
