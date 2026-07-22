import "dotenv/config";
/**
 * CLI backfill истории QUO. DRY-RUN по умолчанию; реальный импорт требует ЯВНОГО --live --confirm.
 * Перед реальным запуском ВСЕГДА печатает dry-run. Требует QUO_API_KEY в env (реальные креды —
 * НЕ в git). Не включает QUO_ENABLED. Пример:
 *   npx tsx scripts/quo-backfill.ts --days 30
 *   npx tsx scripts/quo-backfill.ts --from 2026-06-01 --to 2026-06-30 --site <siteId>
 *   npx tsx scripts/quo-backfill.ts --live --confirm --days 7 --phone-number-id PN123
 *   npx tsx scripts/quo-backfill.ts --reprocess-unlinked
 */
import { prisma } from "@/lib/db";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { runBackfill, type BackfillReport } from "@/integrations/quo/backfill";
import { reprocessUnlinkedCommunications } from "@/integrations/quo/communicationsService";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function printReport(r: BackfillReport): void {
  console.log(`\n=== BACKFILL ${r.mode} (run ${r.runId}) ===`);
  console.log("Магазины:", r.sites.join(", ") || "—");
  console.log("Счётчики:", JSON.stringify(r.counters));
  console.log("По типам:", JSON.stringify(r.breakdown.byType));
  console.log("По магазинам:", JSON.stringify(r.breakdown.bySite));
}

async function main() {
  if (flag("reprocess-unlinked")) {
    const res = await reprocessUnlinkedCommunications(prisma, {});
    console.log("REPROCESS_UNLINKED", JSON.stringify(res));
    return;
  }

  const cfg = getQuoConfig();
  if (!cfg) { console.error("QUO_API_KEY не задан — backfill невозможен."); process.exit(1); }
  const client = createQuoClient(cfg); // retries на 429/5xx (безопасно для GET)

  const days = Number(arg("days") ?? "30");
  const to = arg("to") ? new Date(arg("to")!) : new Date();
  const from = arg("from") ? new Date(arg("from")!) : new Date(to.getTime() - days * 24 * 3600 * 1000);
  const siteId = arg("site");
  const quoPhoneNumberId = arg("phone-number-id");
  const common = { from, to, siteId, quoPhoneNumberId, initiatedByUserId: `cli:${process.env.USER ?? "ops"}` };

  console.log(`Период: ${from.toISOString()} .. ${to.toISOString()}${siteId ? ` · site=${siteId}` : ""}${quoPhoneNumberId ? ` · pn=${quoPhoneNumberId}` : ""}`);

  // Всегда сначала dry-run.
  const dry = await runBackfill(prisma, client, { ...common, mode: "DRY_RUN" });
  printReport(dry);

  if (!flag("live")) { console.log("\n(dry-run. Для реального импорта: добавьте --live --confirm)"); return; }
  if (!flag("confirm")) { console.log("\n--live без --confirm: реальный импорт НЕ выполнен. Добавьте --confirm."); return; }

  const live = await runBackfill(prisma, client, { ...common, mode: "LIVE" });
  printReport(live);
}
main().then(() => process.exit(0)).catch((e) => { console.error("BACKFILL_ERR", e instanceof Error ? e.name : String(e)); process.exit(1); });
