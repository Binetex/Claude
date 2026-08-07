/**
 * Выправляет снимки цены флориста, доставшиеся от старого фолбэка «цены нет → цена клиента».
 *
 * ЗАЧЕМ. До правки в `modules/pricing/service.ts` не найденная цена флориста подменялась
 * полной ценой КЛИЕНТА. Число выглядело как настоящая цена, и второстепенный флорист видел
 * его строкой «вам» (JF-1000970: $239 вместо $167). Теперь фолбэк даёт ноль — признак
 * «цена не задана», — но у заказов, назначенных раньше, снимок уже зафиксирован.
 *
 * ЧТО ДЕЛАЕТ. Берёт позиции, где снимок В ТОЧНОСТИ равен цене клиента (подпись старого
 * фолбэка), и переписывает их текущей каталожной ценой флориста. Если её по-прежнему нет —
 * ставит ноль, и заказ становится виден в «Требует заполнения».
 *
 * ЧЕГО НЕ ДЕЛАЕТ:
 *  - не трогает ДОСТАВЛЕННЫЕ и ОТМЕНЁННЫЕ заказы: там сумма уже вошла в заработок, и
 *    менять её задним числом — решение владельца, а не скрипта;
 *  - не трогает итог заказа с ручной ценой: что владелец в неё заложил, из данных не
 *    выводится. У таких заказов выправляется только строка позиции, которую видит флорист;
 *  - не трогает позиции, где снимок и так отличается от цены клиента: там фолбэк не
 *    срабатывал, и подменять честную цену текущей каталожной нельзя — снимок на то и снимок.
 *
 * Отличается от `relink-orphan-catalog-items.ts`: тот чинил ССЫЛКУ на удалённый дубль
 * каталога, этот — САМУ ЦЕНУ там, где ссылка верная, а цены на момент назначения не было.
 *
 * По умолчанию — сухой прогон. Запись только с `--live`.
 */
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import type { OrderStatus } from "../src/generated/prisma/enums";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const LIVE = process.argv.includes("--live");

/** Заказы, где деньги уже сложились: их не трогаем. */
const FINISHED: OrderStatus[] = ["DELIVERED", "CANCELLED"];

const num = (v: unknown) => Number(v);

async function main() {
  const orders = await prisma.order.findMany({
    where: { orderStatus: { notIn: FINISHED }, currentFloristId: { not: null } },
    select: {
      id: true,
      orderNumber: true,
      orderStatus: true,
      priceMode: true,
      floristTotal: true,
      currentFlorist: {
        select: { financeVisibility: true, user: { select: { name: true } } },
      },
      items: {
        select: { id: true, name: true, quantity: true, externalPrice: true, floristItemPrice: true, productId: true, variantId: true },
      },
    },
    orderBy: { deliveryDate: "asc" },
  });

  let changed = 0;

  for (const order of orders) {
    // Подпись старого фолбэка: снимок в точности равен цене клиента.
    const suspect = order.items.filter(
      (i) => num(i.floristItemPrice) > 0 && num(i.floristItemPrice) === num(i.externalPrice)
    );
    if (suspect.length === 0) continue;

    const auto = order.priceMode !== "MANUAL";
    console.log(
      `\n${order.orderNumber}  ${order.orderStatus}  ${order.currentFlorist?.user.name}  режим=${order.priceMode}  итог=$${order.floristTotal}`
    );

    for (const item of suspect) {
      const variant = item.variantId
        ? await prisma.productVariant.findUnique({ where: { id: item.variantId }, select: { floristPrice: true } })
        : null;
      const product = item.productId
        ? await prisma.product.findUnique({ where: { id: item.productId }, select: { floristPrice: true } })
        : null;

      // Тот же приоритет, что в resolveUnitPrices: вариант важнее товара.
      const unit = variant?.floristPrice ?? product?.floristPrice ?? null;
      const line = unit != null ? new Prisma.Decimal(unit).mul(item.quantity) : new Prisma.Decimal(0);

      console.log(
        `   «${item.name}» ×${item.quantity}: $${item.floristItemPrice} → $${line}` +
          (unit == null ? "  (цена по-прежнему не задана → в «Требует заполнения»)" : "")
      );
      changed += 1;

      if (LIVE) {
        await prisma.orderItem.update({ where: { id: item.id }, data: { floristItemPrice: line } });
      }
    }

    if (LIVE && auto) {
      const items = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        select: { floristItemPrice: true },
      });
      // Снимок позиции уже посчитан с количеством — второй раз умножать нельзя.
      const total = items.reduce((acc, i) => acc.add(new Prisma.Decimal(i.floristItemPrice)), new Prisma.Decimal(0));
      await prisma.order.update({ where: { id: order.id }, data: { floristTotal: total } });
      console.log(`   итог заказа: $${order.floristTotal} → $${total}`);
    } else if (!auto) {
      console.log(`   итог заказа $${order.floristTotal} — ручной, не трогаем`);
    }
  }

  console.log(`\n${LIVE ? "Исправлено" : "Будет исправлено"} позиций: ${changed}`);
  if (!LIVE) console.log("Сухой прогон. Для записи добавьте --live.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
