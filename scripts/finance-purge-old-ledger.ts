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
 * Отбор — по ТИПУ записи, а не по дате. Сухой прогон на проде показал, что часть начислений
 * снесённой модели датирована уже августом (доля Насти за 2026-08-02 со сторно и «уточнено»,
 * заказы Olga), поэтому отсечка по дате оставила бы ровно ту путаницу, ради которой всё
 * затевалось. Решения владельца (PAYMENT / PAYMENT_REVERSAL / BONUS / MANUAL_ADJUSTMENT) не
 * трогаются никогда — только они и формируют баланс (см. balance.ts::recordedEntries).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntryType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";

/** Типы снесённой модели: начисления и сторно к ним. В балансе не участвуют. */
const ACCRUAL_TYPES: LedgerEntryType[] = ["ORDER_ACCRUAL", "PRIMARY_FLORIST_SHARE", "CORRECTION"];

const args = process.argv.slice(2);
const live = args.includes("--live") && args.includes("--confirm");

async function main() {
  const doomed = await prisma.ledgerEntry.findMany({
    where: { type: { in: ACCRUAL_TYPES } },
    orderBy: [{ floristNameSnapshot: "asc" }, { effectiveDate: "asc" }],
  });
  const survivors = await prisma.ledgerEntry.findMany({
    where: { type: { notIn: ACCRUAL_TYPES } },
    orderBy: { effectiveDate: "asc" },
  });

  console.log(`Удаляем типы: ${ACCRUAL_TYPES.join(", ")}`);
  console.log(`К удалению: ${doomed.length}. Остаётся: ${survivors.length}.`);

  // Что остаётся — построчно: в книге должны остаться ТОЛЬКО решения владельца.
  if (survivors.length) {
    console.log("Остаются:");
    for (const e of survivors) {
      const day = e.effectiveDate.toISOString().slice(0, 10);
      console.log(`  ${day} ${e.floristNameSnapshot} ${e.type} ${e.direction} ${e.amountCents}¢ ${e.sourceType} «${e.description}»`);
    }
  }

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
    where: { type: { notIn: ACCRUAL_TYPES }, reversedEntryId: { not: null } },
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
    // Два прохода, и порядок важен: сторно ссылается на сторнируемую запись
    // (reversedEntryId, ON DELETE RESTRICT — проверяется построчно и отложить его нельзя).
    // Сначала уходят ссылающиеся CORRECTION, только потом сами начисления.
    const corrections = await tx.$executeRawUnsafe(`DELETE FROM "LedgerEntry" WHERE "type" = 'CORRECTION'`);
    const accruals = await tx.$executeRawUnsafe(
      `DELETE FROM "LedgerEntry" WHERE "type" IN ('ORDER_ACCRUAL', 'PRIMARY_FLORIST_SHARE')`
    );
    const n = corrections + accruals;
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
