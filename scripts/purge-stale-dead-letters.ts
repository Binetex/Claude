/**
 * Чистка мёртвых задач очереди, повтор которых уже ничего не даст.
 *
 * ЗАЧЕМ. Мёртвые задачи видны владельцу на «Системных событиях» красной плашкой, и рядом с
 * каждой стоит кнопка «Повторить». Пока их единицы — это сигнал. Когда их девяносто, из
 * которых большинство — один и тот же провал, повторённый реконсиляцией по кругу, сигнал
 * тонет, а кнопка «Повторить» у протухшего события становится опасной: SMS о доставке
 * недельной давности отправлять уже нельзя.
 *
 * ПРАВИЛО УДАЛЕНИЯ — «повтор бесполезен или вреден»:
 *  1. задача создания доставки, а заказ уже доставлен, отменён или удалён — везти нечего;
 *  2. любое другое мёртвое событие старше порога — повтор такого уже не нужен.
 *
 * ЧТО СОХРАНЯЕТСЯ ВСЕГДА. Задача создания доставки по ЖИВОМУ заказу. Она держит стоп:
 * реконсиляция пропускает заказ именно потому, что видит мёртвую задачу (см. recovery.ts).
 * Удалить её — значит вернуть круг «ставим заново → падает → уведомление» каждый час. Она же
 * служит владельцу ручкой: с той самой кнопкой «Повторить», когда данные заказа поправят.
 *
 * По умолчанию — сухой прогон. Запись только с `--live`.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TERMINAL_ORDER_STATUSES } from "../src/lib/statuses";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const LIVE = process.argv.includes("--live");

const BURQ_DRAFT = "burq.draft.create.requested";
/** Старше этого повтор события уже не имеет смысла. */
const STALE_DAYS = 3;

async function main() {
  const dead = await prisma.outboxEvent.findMany({
    where: { status: "DEAD_LETTER" },
    select: { id: true, eventType: true, aggregateId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Заказы, по которым мёртвая задача доставки ещё работает стоп-меткой.
  const draftOrderIds = [...new Set(dead.filter((e) => e.eventType === BURQ_DRAFT).map((e) => e.aggregateId))];
  const openOrders = new Set(
    (
      await prisma.order.findMany({
        where: { id: { in: draftOrderIds }, orderStatus: { notIn: TERMINAL_ORDER_STATUSES } },
        select: { id: true },
      })
    ).map((o) => o.id)
  );

  const staleBefore = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const remove: typeof dead = [];
  const keep: typeof dead = [];

  for (const e of dead) {
    if (e.eventType === BURQ_DRAFT) {
      // Живой заказ — задача держит стоп и остаётся ручкой для владельца.
      (openOrders.has(e.aggregateId) ? keep : remove).push(e);
      continue;
    }
    (e.createdAt < staleBefore ? remove : keep).push(e);
  }

  const byType = (list: typeof dead) => {
    const m = new Map<string, number>();
    for (const e of list) m.set(e.eventType, (m.get(e.eventType) ?? 0) + 1);
    return [...m.entries()].map(([t, n]) => `${t}: ${n}`).join("\n    ");
  };

  console.log(`Мёртвых задач всего: ${dead.length}\n`);
  console.log(`${LIVE ? "УДАЛЕНО" : "Будет удалено"}: ${remove.length}\n    ${byType(remove) || "—"}`);
  console.log(`\nОставлено: ${keep.length}\n    ${byType(keep) || "—"}`);
  if (keep.some((e) => e.eventType === BURQ_DRAFT)) {
    console.log("    (задачи доставки по незакрытым заказам — держат стоп, см. шапку файла)");
  }

  if (!LIVE) {
    console.log("\nСухой прогон. Для записи добавьте --live.");
    return;
  }
  if (remove.length === 0) return;

  const res = await prisma.outboxEvent.deleteMany({ where: { id: { in: remove.map((e) => e.id) } } });
  console.log(`\nФактически удалено строк: ${res.count}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
