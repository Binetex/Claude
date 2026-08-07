/**
 * Перепривязка позиций заказов, «прилипших» к удалённому дублю каталога.
 *
 * ЗАЧЕМ. Один внешний id мог оказаться в каталоге дважды: живая вариация товара и её же
 * копия, заведённая отдельным товаром и позже помеченная удалённой. Приём заказа брал
 * произвольную из двух (исправлено в modules/catalog/matchIndex.ts), и часть заказов
 * связалась с удалённой записью. У той нет ни состава букета, ни цены флориста, поэтому
 * снимок цены упал на фолбэк «цены нет → берём цену клиента»: второстепенный флорист
 * видел в позиции полную сумму заказа (JF-1000970 — $239 вместо $167).
 *
 * ЧТО ДЕЛАЕТ. Для живых заказов находит позиции, чей вариант помечен удалённым, ищет
 * живого двойника по тому же внешнему id и переставляет ссылку на него. Заодно
 * пересчитывает снимок цены флориста — но ТОЛЬКО у заказов с авто-ценой: ручную сумму,
 * введённую владельцем, скрипт не трогает никогда.
 *
 * По умолчанию — сухой прогон. Запись только с `--live`.
 *
 *   npx tsx scripts/relink-orphan-catalog-items.ts          # показать, что будет сделано
 *   npx tsx scripts/relink-orphan-catalog-items.ts --live   # применить
 */
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import type { OrderStatus } from "../src/generated/prisma/enums";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const LIVE = process.argv.includes("--live");

/** Заказы, которые ещё в работе: у доставленных и отменённых менять снимок нельзя. */
const DONE: OrderStatus[] = ["CANCELLED", "DELIVERED"];
const ACTIVE = { orderStatus: { notIn: DONE } };

async function main() {
  const orders = await prisma.order.findMany({
    where: ACTIVE,
    select: {
      id: true,
      orderNumber: true,
      priceMode: true,
      floristTotal: true,
      siteId: true,
      currentFlorist: { select: { user: { select: { name: true } } } },
      items: {
        select: { id: true, name: true, productId: true, variantId: true, externalPrice: true, floristItemPrice: true },
      },
    },
    orderBy: { deliveryDate: "asc" },
  });

  let touched = 0;

  for (const order of orders) {
    for (const item of order.items) {
      if (!item.variantId) continue;

      const current = await prisma.productVariant.findUnique({
        where: { id: item.variantId },
        select: { id: true, externalId: true, remoteDeleted: true, productId: true },
      });
      if (!current || !current.remoteDeleted) continue;

      // Живой двойник по тому же внешнему id в том же магазине.
      const live = await prisma.productVariant.findFirst({
        where: {
          externalId: current.externalId,
          remoteDeleted: false,
          product: { siteId: order.siteId },
        },
        select: {
          id: true,
          title: true,
          floristPrice: true,
          floristComposition: true,
          productId: true,
          product: { select: { name: true } },
        },
        orderBy: { lastSyncedAt: "desc" },
      });

      if (!live) {
        console.log(`· ${order.orderNumber} «${item.name}»: живого двойника нет, пропуск`);
        continue;
      }

      const auto = order.priceMode !== "MANUAL";
      const newPrice = live.floristPrice;
      touched += 1;

      console.log(
        `${LIVE ? "✔" : "→"} ${order.orderNumber} (${order.currentFlorist?.user.name ?? "без флориста"}, ${order.priceMode})\n` +
          `    позиция «${item.name}»\n` +
          `    вариант: удалённый ${current.id} → живой «${live.product.name} / ${live.title}» ${live.id}\n` +
          `    цена флориста: ${item.floristItemPrice} → ${newPrice ?? "не задана"}` +
          (auto ? "" : "  (ручная сумма заказа — итог НЕ трогаем)")
      );

      if (!LIVE) continue;

      await prisma.$transaction(async (tx) => {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            variantId: live.id,
            productId: live.productId,
            // Состав букета — снимок на момент назначения; у удалённой записи его не было.
            ...(live.floristComposition ? { floristCompositionSnapshot: live.floristComposition } : {}),
            // Цена позиции выправляется всегда: именно она показывается флористу строкой
            // «вам», и сейчас там стоит цена клиента.
            ...(newPrice != null ? { floristItemPrice: newPrice } : {}),
          },
        });

        // Итог заказа пересобираем ТОЛЬКО у авто-цены. Ручную сумму владелец ввёл сам —
        // что он в неё заложил, из данных не выводится, и молча менять её нельзя.
        if (auto && newPrice != null) {
          const items = await tx.orderItem.findMany({
            where: { orderId: order.id },
            select: { floristItemPrice: true, quantity: true },
          });
          const total = items.reduce(
            (acc, i) => acc.add(new Prisma.Decimal(i.floristItemPrice).mul(i.quantity)),
            new Prisma.Decimal(0)
          );
          await tx.order.update({ where: { id: order.id }, data: { floristTotal: total } });
        }
      });
    }
  }

  console.log(`\n${LIVE ? "Исправлено" : "Будет исправлено"} позиций: ${touched}`);
  if (!LIVE) console.log("Сухой прогон. Для записи добавьте --live.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
