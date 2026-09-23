import "dotenv/config";
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getBurqRuntimeClient } from "../src/integrations/delivery/burq/settings";
import { pickCostCents, centsToDollars } from "../src/integrations/delivery/burq/costCapture";

/**
 * Досыпает фактическую стоимость ДОСТАВЛЕННЫМ доставкам, у которых её нет.
 *
 * Зачем разово: до 23.09.2026 сумма принималась только у Uber, и заказы, которые Burq отдал
 * другому курьеру, остались без стоимости — в карточке «Доставка (факт): не подтверждена», а
 * день флориста не считался. Код исправлен, но прошлые доставки новых событий уже не получат:
 * webhook по ним отработал месяц назад. Суммы берутся у Burq, ничего не выдумывается.
 *
 *   npx tsx scripts/burq-backfill-final-cost.ts            # показать, что будет записано
 *   npx tsx scripts/burq-backfill-final-cost.ts --live     # записать
 *
 * Безопасно повторять: доставка с уже проставленной суммой не трогается.
 */
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const live = process.argv.includes("--live");
  const rows = await prisma.delivery.findMany({
    where: { status: "DELIVERED", finalCost: null, externalDeliveryId: { not: null } },
    select: { id: true, externalDeliveryId: true, orderId: true, order: { select: { orderNumber: true, deliveryActualCost: true, deliveryActualCostConfirmedAt: true } } },
  });
  console.log(`Доставленных без суммы: ${rows.length}`);
  if (rows.length === 0) return;

  const client = await getBurqRuntimeClient();
  let written = 0;
  for (const d of rows) {
    const remote = await client.getOrder(d.externalDeliveryId!);
    const cents = pickCostCents(remote.totalAmountDueCents ?? null, remote.feeCents ?? null);
    if (cents == null) {
      console.log(`  ${d.order?.orderNumber}: у Burq суммы нет — пропуск`);
      continue;
    }
    const dollars = centsToDollars(cents);
    console.log(`  ${d.order?.orderNumber}: ${remote.provider ?? "—"} → $${dollars.toFixed(2)}`);
    if (!live) continue;

    await prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: d.id },
        data: { finalCost: new Prisma.Decimal(dollars), finalCostUpdatedAt: new Date(), currency: remote.currency ?? "USD", providerName: remote.provider ?? null },
      });
      // Фактическую стоимость заказа перезаписываем ТОЛЬКО если её не подтверждал человек:
      // его цифра сильнее любой пришедшей от провайдера.
      if (!d.order?.deliveryActualCostConfirmedAt) {
        await tx.order.update({
          where: { id: d.orderId },
          data: { deliveryActualCost: new Prisma.Decimal(dollars), deliveryActualCostSource: "BURQ" },
        });
      }
    });
    written += 1;
  }
  console.log(live ? `\nЗаписано: ${written}. Пересчитайте дни: npm run finance:recompute` : "\nDRY-RUN. Повторите с --live.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
