import "dotenv/config";
/**
 * Превью Stage 2: что именно получится, если включить начисления и создать финансовые
 * профили. По умолчанию НИЧЕГО НЕ ПИШЕТ — только читает и печатает.
 *
 * Запуск (превью):
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=... npx tsx scripts/finance-stage2-dryrun.ts
 *
 * Применение профилей (только после того, как владелец увидел превью):
 *   ... npx tsx scripts/finance-stage2-dryrun.ts --apply-profiles
 *
 * Начисления этот скрипт не создаёт НИКОГДА: их делает воркер после включения
 * FINANCE_ACCRUAL_ENABLED. Здесь только показано, что он начислит.
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { toNumber } from "@/lib/money";
import { assessAccrual } from "@/modules/finance/accrualRules";
import { setFinanceProfile } from "@/modules/finance/profile";
import type { FinanceModel } from "@/generated/prisma/enums";

const APPLY_PROFILES = process.argv.includes("--apply-profiles");

/**
 * Целевая конфигурация. Флористы ищутся ПО EMAIL, а не по захардкоженному id: id
 * различаются между окружениями, а перепутать финансовую модель нельзя.
 */
const TARGET: { email: string; model: FinanceModel }[] = [
  { email: "nastya@gmail.com", model: "PRIMARY" },
  { email: "olga@gmail.com", model: "SECONDARY" },
  { email: "natasha@gmail.com", model: "SECONDARY" },
];

/** Дата, с которой имеет смысл начислять: раньше неё флористов заказам не назначали. */
const START_DATE = new Date(process.env.FINANCE_ACCRUAL_START_DATE ?? "2026-07-01");

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Есть ли в базе таблицы Stage 2. Скрипт должен работать и ДО применения миграции —
 * ровно тогда владельцу и нужно превью, чтобы решить, применять ли её вообще.
 */
async function hasStage2Tables(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'FloristFinanceProfile'`;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const migrated = await hasStage2Tables(prisma);

  try {
    console.log(`\n${"=".repeat(78)}`);
    console.log(APPLY_PROFILES ? "STAGE 2 — СОЗДАНИЕ ПРОФИЛЕЙ" : "STAGE 2 — DRY-RUN (ничего не пишется)");
    console.log(`Дата старта начислений: ${START_DATE.toISOString().slice(0, 10)}`);
    console.log(`Миграция Stage 2: ${migrated ? "применена" : "НЕ применена (превью по данным заказов)"}`);
    console.log("=".repeat(78));

    if (APPLY_PROFILES && !migrated) {
      throw new Error("миграция Stage 2 не применена — создавать профили негде");
    }

    // ── 1. Флористы и их будущие профили ──
    const florists = await prisma.florist.findMany({
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });

    console.log("\n── 1. Финансовые профили ──");
    const plan: { floristId: string; name: string; model: FinanceModel }[] = [];
    for (const t of TARGET) {
      const f = florists.find((x) => x.user.email.toLowerCase() === t.email);
      if (!f) {
        console.log(`  ⚠ ${t.email} — флорист не найден, пропускаю`);
        continue;
      }
      const existing = migrated
        ? await prisma.floristFinanceProfile.findFirst({
            where: { floristId: f.id, active: true, effectiveTo: null },
          })
        : null;
      const state = existing ? `уже есть: ${existing.model} с ${existing.effectiveFrom.toISOString().slice(0, 10)}` : "будет создан";
      console.log(`  ${f.user.name.padEnd(10)} ${f.id}  →  ${t.model.padEnd(9)} (${state})`);
      if (!existing) plan.push({ floristId: f.id, name: f.user.name, model: t.model });
    }

    const unlisted = florists.filter((f) => !TARGET.some((t) => t.email === f.user.email.toLowerCase()));
    for (const f of unlisted) {
      console.log(`  ⚠ ${f.user.name} (${f.user.email}) — в целевой конфигурации нет, профиль НЕ создаётся`);
    }

    // ── 2. Что начислит воркер ──
    console.log("\n── 2. Начисления, которые создаст воркер после включения ──");
    const orders = await prisma.order.findMany({
      where: {
        orderStatus: "DELIVERED",
        deliveryDate: { gte: START_DATE },
        // Как и в диспетчере: назначенный флорист важнее происхождения записи заказа.
        currentFloristId: { not: null },
      },
      orderBy: [{ currentFloristId: "asc" }, { deliveryDate: "asc" }],
      select: {
        id: true,
        orderNumber: true,
        deliveryDate: true,
        priceMode: true,
        floristTotal: true,
        currentFloristId: true,
        currentFlorist: { select: { user: { select: { name: true, email: true } } } },
        items: { select: { name: true, productId: true, variantId: true, floristItemPrice: true } },
      },
    });

    const totals = new Map<string, { name: string; model: FinanceModel | "—"; count: number; cents: number; skipped: number }>();
    const rows: string[] = [];

    for (const o of orders) {
      const email = o.currentFlorist?.user.email.toLowerCase() ?? "";
      const model = TARGET.find((t) => t.email === email)?.model ?? "—";
      const name = o.currentFlorist?.user.name ?? "?";
      const key = o.currentFloristId!;
      const acc = totals.get(key) ?? { name, model, count: 0, cents: 0, skipped: 0 };

      if (model !== "SECONDARY") {
        // PRIMARY считается долей за период на Stage 3; профиля нет — начислять нечего.
        acc.skipped++;
        totals.set(key, acc);
        continue;
      }

      const assessment = assessAccrual({
        priceMode: o.priceMode,
        floristTotal: toNumber(o.floristTotal),
        items: o.items.map((i) => ({ ...i, floristItemPrice: toNumber(i.floristItemPrice) })),
      });

      if (assessment.status !== "OK") {
        acc.skipped++;
        rows.push(
          `  ⚠ ${name.padEnd(8)} ${o.orderNumber.padEnd(15)} ${o.deliveryDate.toISOString().slice(0, 10)}  цена не задана → в очередь разбора`
        );
      } else {
        acc.count++;
        acc.cents += assessment.amountCents;
        const stored = toNumber(o.floristTotal);
        const diff = Math.round(stored * 100) - assessment.amountCents;
        const note = diff !== 0 ? `  (снимок ${usd(Math.round(stored * 100))}, минус чаевые ${usd(diff)})` : "";
        rows.push(
          `    ${name.padEnd(8)} ${o.orderNumber.padEnd(15)} ${o.deliveryDate.toISOString().slice(0, 10)}  ${o.priceMode.padEnd(6)} ${usd(assessment.amountCents).padStart(9)}${note}`
        );
      }
      totals.set(key, acc);
    }

    for (const line of rows) console.log(line);

    console.log("\n── 3. Итог по флористам ──");
    for (const [, t] of totals) {
      console.log(
        `  ${t.name.padEnd(10)} ${String(t.model).padEnd(10)} начислений: ${String(t.count).padStart(3)}  на ${usd(t.cents).padStart(10)}  пропущено: ${t.skipped}`
      );
    }

    // ── 4. Очередь разбора ──
    const noFlorist = await prisma.order.count({
      where: { orderStatus: "DELIVERED", deliveryDate: { gte: START_DATE }, currentFloristId: null, isBackfilled: false },
    });
    const backfilled = await prisma.order.count({
      where: { orderStatus: "DELIVERED", currentFloristId: null, isBackfilled: true },
    });
    console.log("\n── 4. Очередь разбора ──");
    console.log(`  Доставлено без исполнителя (живые заказы, с даты старта): ${noFlorist}`);
    console.log(`  Исторический backfill Shopify (в очередь НЕ попадает):     ${backfilled}`);

    // ── 5. Применение ──
    if (!APPLY_PROFILES) {
      console.log(`\n${"=".repeat(78)}`);
      console.log("DRY-RUN: ничего не записано.");
      console.log("Создать профили: добавить флаг --apply-profiles");
      console.log("=".repeat(78));
      return;
    }

    const owner = await prisma.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" } });
    if (!owner) throw new Error("активный OWNER не найден — некому приписать профиль");

    console.log("\n── 5. Создание профилей ──");
    for (const p of plan) {
      const { createdId } = await setFinanceProfile({
        floristId: p.floristId,
        model: p.model,
        // Доля основного флориста НЕ задаётся на этом этапе: расчёт 66.6% — Stage 3,
        // а хранить процент, по которому пока ничего не считается, значит обещать неверное.
        sharePercentBp: null,
        effectiveFrom: START_DATE,
        comment: "Stage 2: начальная конфигурация",
        actor: { userId: owner.id, role: "OWNER" },
      });
      console.log(`  ✓ ${p.name}: ${p.model} с ${START_DATE.toISOString().slice(0, 10)} (${createdId})`);
    }
    if (plan.length === 0) console.log("  (все профили уже существуют — ничего не создано)");
  } finally {
    // Prisma 7: соединение закрывается вместе с процессом.
  }
}

main().catch((err) => {
  console.error("ОШИБКА:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
