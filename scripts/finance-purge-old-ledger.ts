import "dotenv/config";
/**
 * Разовая чистка «Истории операций» перед открытием финансов работникам.
 *
 * В книге остались начисления СНЕСЁННОЙ модели (ORDER_ACCRUAL / PRIMARY_FLORIST_SHARE). На
 * баланс они уже не влияют — заработок теперь выводится, а не хранится, — но работник увидит
 * их в истории и не сойдётся со своей суммой к выплате. Владелец решил убрать их физически и
 * начать отсчёт с 2026-08-01.
 *
 *   npx tsx scripts/finance-purge-old-ledger.ts                       # DRY-RUN: что удалится
 *   npx tsx scripts/finance-purge-old-ledger.ts --live --confirm      # удалить (с бэкапом)
 *
 * DRY-RUN по умолчанию. Перед удалением скрипт ВСЕГДА пишет JSON-бэкап всех удаляемых строк
 * рядом с собой (backup-ledger-<timestamp>.json) — восстановить можно обычным INSERT.
 *
 * `LedgerEntry` append-only на уровне БД (триггеры LedgerEntry_no_update/no_delete). Это
 * осознанная защита, поэтому обход здесь ОДИН, явный и узкий: триггер удаления снимается и
 * возвращается внутри одной транзакции, ничего другого скрипт не трогает.
 *
 * Отсечка по effectiveDate — бизнес-дате операции, той же, по которой история сортируется.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/db";

const CUTOFF = new Date("2026-08-01T00:00:00.000Z");

const args = process.argv.slice(2);
const live = args.includes("--live") && args.includes("--confirm");

async function main() {
  const doomed = await prisma.ledgerEntry.findMany({
    where: { effectiveDate: { lt: CUTOFF } },
    orderBy: [{ floristNameSnapshot: "asc" }, { effectiveDate: "asc" }],
  });
  const survivors = await prisma.ledgerEntry.count({ where: { effectiveDate: { gte: CUTOFF } } });

  console.log(`Отсечка: ${CUTOFF.toISOString().slice(0, 10)}`);
  console.log(`К удалению: ${doomed.length}. Остаётся: ${survivors}.`);

  const byFlorist = new Map<string, Map<string, number>>();
  for (const e of doomed) {
    const perType = byFlorist.get(e.floristNameSnapshot) ?? new Map<string, number>();
    perType.set(e.type, (perType.get(e.type) ?? 0) + 1);
    byFlorist.set(e.floristNameSnapshot, perType);
  }
  for (const [name, perType] of byFlorist) {
    console.log(`  ${name}: ${[...perType].map(([t, n]) => `${t}=${n}`).join(", ")}`);
  }

  // Инвариант: выжившая запись не должна ссылаться на удаляемую (сторно/исправление).
  // Иначе DELETE упрётся в ON DELETE RESTRICT — лучше узнать это до, чем в середине.
  const doomedIds = new Set(doomed.map((e) => e.id));
  const danglingReversals = await prisma.ledgerEntry.findMany({
    where: { effectiveDate: { gte: CUTOFF }, reversedEntryId: { not: null } },
    select: { id: true, reversedEntryId: true },
  });
  const broken = danglingReversals.filter((r) => r.reversedEntryId && doomedIds.has(r.reversedEntryId));
  if (broken.length) {
    console.error(`СТОП: ${broken.length} выживших записей сторнируют удаляемые. Разберите вручную.`);
    process.exitCode = 1;
    return;
  }

  if (doomed.length === 0) {
    console.log("Удалять нечего.");
    return;
  }

  if (!live) {
    console.log("\nDRY-RUN. Ничего не удалено. Для удаления: --live --confirm");
    return;
  }

  const backupPath = join(process.cwd(), `backup-ledger-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify(doomed, null, 2));
  console.log(`Бэкап: ${backupPath}`);

  const deleted = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" DISABLE TRIGGER "LedgerEntry_no_delete"`);
    const n = await tx.$executeRawUnsafe(`DELETE FROM "LedgerEntry" WHERE "effectiveDate" < $1`, CUTOFF);
    await tx.$executeRawUnsafe(`ALTER TABLE "LedgerEntry" ENABLE TRIGGER "LedgerEntry_no_delete"`);
    return n;
  });
  console.log(`Удалено: ${deleted}.`);

  const left = await prisma.ledgerEntry.count();
  console.log(`Всего записей в книге осталось: ${left}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
