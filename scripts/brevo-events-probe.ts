/**
 * ДИАГНОСТИКА (только чтение): что Brevo сделал с нашими письмами.
 *
 * Наша сторона знает лишь «Brevo принял запрос и вернул messageId». Дальше письмо живёт в Brevo,
 * и единственный источник правды об исходе — журнал событий аккаунта. Скрипт спрашивает его
 * ключом КОНКРЕТНОГО магазина: кто аккаунт, какие отправители подтверждены, какие события были.
 *
 * Ничего не пишет: ни в БД, ни в Brevo. Только GET-запросы и вывод в консоль. Ключ не печатается.
 *
 *   npx tsx scripts/brevo-events-probe.ts <shortName> [email-получателя]
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decryptSecret } from "../src/lib/crypto/secretBox";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const shortName = process.argv[2];
const recipient = process.argv[3];

async function get(path: string, key: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: "GET",
    headers: { "api-key": key, accept: "application/json" },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text };
  }
}

async function main() {
  if (!shortName) throw new Error("Укажите shortName магазина: npx tsx scripts/brevo-events-probe.ts THEFLOW [email]");

  const site = await prisma.site.findFirst({ where: { shortName }, select: { id: true, name: true, shortName: true } });
  if (!site) throw new Error(`Магазин ${shortName} не найден`);

  const row = await prisma.integrationSecret.findFirst({
    where: { provider: "BREVO", kind: "api_key", active: true, siteId: site.id },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new Error(`У ${shortName} нет ключа Brevo`);
  const key = decryptSecret(row.encryptedValue);

  console.log(`Магазин: ${site.name} (${site.shortName}), ключ ${row.maskedSuffix}\n`);

  const account = await get("/account", key);
  const acc = account.body as { email?: string; plan?: unknown[] } | null;
  console.log(`АККАУНТ: HTTP ${account.status}, email=${acc?.email ?? "—"}`);
  if (acc?.plan) console.log(`  план: ${JSON.stringify(acc.plan)}`);

  const senders = await get("/senders", key);
  const sndrs = (senders.body as { senders?: { email?: string; name?: string; active?: boolean }[] } | null)?.senders ?? [];
  console.log(`\nОТПРАВИТЕЛИ: HTTP ${senders.status}`);
  for (const s of sndrs) console.log(`  ${s.email} (${s.name ?? "—"}) active=${s.active}`);

  const q = new URLSearchParams({ limit: "50", offset: "0" });
  if (recipient) q.set("email", recipient);
  const events = await get(`/smtp/statistics/events?${q}`, key);
  const list = (events.body as { events?: { email?: string; date?: string; event?: string; reason?: string; subject?: string; messageId?: string }[] } | null)?.events ?? [];
  console.log(`\nСОБЫТИЯ: HTTP ${events.status}, записей ${list.length}${recipient ? ` (фильтр по ${recipient})` : ""}`);
  if (events.status !== 200) console.log(`  ответ: ${JSON.stringify(events.body)}`);
  for (const e of list) {
    console.log(`  ${e.date ?? "—"}  ${String(e.event ?? "—").padEnd(12)} ${e.email ?? "—"}${e.reason ? `  причина: ${e.reason}` : ""}${e.subject ? `  тема: ${e.subject}` : ""}`);
  }

  // Шаблон, которым уходит тест: он должен существовать и быть активным именно в ЭТОМ аккаунте.
  const tpl = await prisma.siteEmailTemplate.findFirst({ where: { siteId: site.id }, orderBy: { triggerType: "asc" } });
  if (tpl) {
    const t = await get(`/smtp/templates/${tpl.brevoTemplateId}`, key);
    const tb = t.body as { name?: string; isActive?: boolean; sender?: { email?: string } } | null;
    console.log(`\nШАБЛОН ${tpl.brevoTemplateId} (${tpl.triggerType}): HTTP ${t.status}, name=${tb?.name ?? "—"}, isActive=${tb?.isActive}, sender=${tb?.sender?.email ?? "—"}`);
    if (t.status !== 200) console.log(`  ответ: ${JSON.stringify(t.body)}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
