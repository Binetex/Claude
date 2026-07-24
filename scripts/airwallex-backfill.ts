import "dotenv/config";
/**
 * Точечный backfill мониторинга Airwallex для УЖЕ существующих заказов.
 * DRY-RUN по умолчанию; реальная запись требует ЯВНОГО --live --confirm.
 *
 *   npx tsx scripts/airwallex-backfill.ts --site THEFLOW --orders 20291,20253
 *   npx tsx scripts/airwallex-backfill.ts --site THEFLOW --orders 20291,20253 --probe
 *   npx tsx scripts/airwallex-backfill.ts --site THEFLOW --orders 20291,20253 --live --confirm
 *   npx tsx scripts/airwallex-backfill.ts --site THEFLOW --limit 1        # без списка: N свежих
 *
 * --probe: одноразовый READ-ONLY запрос статуса в Airwallex (GET payment_intent) с показом сырого
 * статуса, последней попытки и нормализации. Ничего не пишет, ничего не рассылает — способ узнать
 * реальный статус платежа, не заводя мониторинг. Единственный режим, который ходит в Airwallex.
 *
 * --from-now: OVERRIDE для теста старого заказа — отсчёт 7-дневного потолка от «сейчас», а не от
 * даты заказа. Без него заказ старше 7 дней не берётся в мониторинг (потолок уже истёк).
 *
 * Что делает: по каждому заказу читает свежие данные из Woo (status, payment_method,
 * payment_method_title, transaction_id, meta) и, если найден однозначный payment intent,
 * создаёт запись AirwallexPayment. Задачу сверки НЕ ставит — её подхватит штатный диспетчер
 * воркера в течение 5 минут (backfill не дублирует планирование и заодно проверяет диспетчер).
 *
 * Чего НЕ делает НИКОГДА: не шлёт Telegram и не меняет business status заказа (paymentStatus,
 * paymentClassification, orderStatus, назначение флориста, статус в Woo). В Airwallex ходит только
 * с --probe. В dry-run не пишет в БД вообще.
 *
 * Гейты: Verify Airwallex у сайта обязателен всегда; включённая галочка мониторинга — только
 * для --live, чтобы backfill не стал способом обойти порядок включения.
 */
import { prisma } from "@/lib/db";
import { resolveWooCredentials } from "@/integrations/woocommerce/credentials";
import { wooGet } from "@/integrations/woocommerce/client";
import { extractIntentId, upsertAirwallexPayment, WOO_INTENT_META_KEY } from "@/integrations/airwallex/reconcile";
import { isAirwallexMethod, initialStopAt, normalize } from "@/integrations/airwallex/policy";
import { AirwallexClient } from "@/integrations/airwallex/client";
import { resolveAirwallexCreds } from "@/integrations/airwallex/settings";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type WooMeta = { key?: string; value?: unknown };
type WooOrder = {
  status?: string;
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string | null;
  meta_data?: WooMeta[];
};

/** Идентификаторы в лог — только в маскированном виде. */
function mask(v: string | null | undefined): string {
  if (!v) return "—";
  return v.length <= 10 ? `${v.slice(0, 3)}****` : `${v.slice(0, 6)}****${v.slice(-4)}`;
}

/** Meta со словом airwallex/intent. Значение показываем открыто только у статусных ключей. */
function relevantMeta(meta: WooMeta[] | undefined): string[] {
  return (meta ?? [])
    .filter((m) => typeof m.key === "string" && /airwallex|payment_intent/i.test(m.key))
    .map((m) => {
      const key = String(m.key);
      const raw = typeof m.value === "string" ? m.value : JSON.stringify(m.value ?? null);
      const safe = /status|state|method|env|mode/i.test(key) ? raw : mask(raw);
      return `${key}=${safe}`;
    });
}

async function main() {
  const shortName = arg("site");
  if (!shortName) { console.error("Укажите --site <shortName>, например --site THEFLOW"); process.exit(1); }

  const refs = (arg("orders") ?? arg("order") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const limit = Number(arg("limit") ?? "1");
  const probe = flag("probe");
  const live = flag("live") && flag("confirm") && !probe; // probe никогда не пишет
  const fromNow = flag("from-now");
  const mode = probe ? "PROBE (read-only)" : live ? "LIVE" : "DRY-RUN";

  const site = await prisma.site.findFirst({
    where: { shortName },
    select: {
      id: true, name: true, shortName: true,
      wooConnection: { select: { airwallexMonitoringEnabled: true, airwallexApiVerifiedAt: true, airwallexApiConnStatus: true } },
    },
  });
  if (!site) { console.error(`Сайт ${shortName} не найден.`); process.exit(1); }

  const conn = site.wooConnection;
  if (!conn?.airwallexApiVerifiedAt) { console.error(`У ${shortName} не пройден Verify Airwallex — backfill запрещён.`); process.exit(1); }
  if (live && !conn.airwallexMonitoringEnabled) {
    console.error(`У ${shortName} выключена галочка мониторинга — сначала включите её, потом --live.`);
    process.exit(1);
  }

  console.log(`\n=== AIRWALLEX BACKFILL ${mode} — ${site.name} (${site.shortName}) ===`);
  console.log(`Verify: ${conn.airwallexApiConnStatus} (${conn.airwallexApiVerifiedAt.toISOString()}) | галочка мониторинга: ${conn.airwallexMonitoringEnabled}`);
  console.log(refs.length ? `Заказы (строго): ${refs.join(", ")}` : `Без списка: ${limit} свежих подходящих`);

  const orders = await prisma.order.findMany({
    where: {
      siteId: site.id,
      ...(refs.length
        ? { OR: [{ orderNumber: { in: refs } }, { externalId: { in: refs } }] }
        : { airwallexPayment: null }),
    },
    select: {
      id: true, orderNumber: true, externalId: true, paymentMethod: true,
      paymentStatus: true, externalStatus: true, externalCreatedAt: true,
      airwallexPayment: { select: { id: true, paymentIntentId: true } },
    },
    orderBy: { externalCreatedAt: "desc" },
    take: refs.length ? refs.length * 2 : limit,
  });

  if (refs.length) {
    const missing = refs.filter((r) => !orders.some((o) => o.orderNumber === r || o.externalId === r || o.orderNumber.endsWith(`-${r}`)));
    if (missing.length) console.log(`⚠️  не найдены в БД ${site.shortName}: ${missing.join(", ")}`);
  }

  const creds = await resolveWooCredentials(site.id);
  const now = new Date();
  let created = 0;

  for (const o of orders) {
    let woo: WooOrder | undefined;
    let wooError: string | null = null;
    try {
      woo = (await wooGet<WooOrder>(creds, `/orders/${o.externalId}`)).data;
    } catch (err) {
      wooError = `Woo API: ${err instanceof Error ? err.message.slice(0, 90) : "ошибка"}`;
    }

    const intentId = extractIntentId(woo?.meta_data);
    // --from-now: явный override для теста старого заказа, иначе отсчёт от даты заказа.
    const firstSeenAt = fromNow ? now : (o.externalCreatedAt ?? now);
    const stopAt = initialStopAt(firstSeenAt);
    const expired = stopAt.getTime() <= now.getTime();
    const wooMethodOk = isAirwallexMethod(woo?.payment_method);

    // Причина отказа — по одной, в порядке значимости.
    const blocked =
      wooError ? wooError
      : o.airwallexPayment ? `запись мониторинга уже есть (intent ${mask(o.airwallexPayment.paymentIntentId)})`
      : !wooMethodOk ? `в Woo текущий gateway = ${woo?.payment_method ?? "?"} — не Airwallex (см. #20295)`
      : !intentId ? `intent id не найден в meta ${WOO_INTENT_META_KEY}`
      : expired ? `потолок мониторинга (7 дней от даты заказа) уже истёк`
      : null;

    console.log(
      `\n──────────────────────────────────────────────\n` +
      `Woo order number:        ${o.externalId}  (у нас: ${o.orderNumber})\n` +
      `локальный Order ID:      ${o.id}\n` +
      `Woo status:              ${woo?.status ?? "—"}   (локально: ${o.externalStatus} / оплата ${o.paymentStatus})\n` +
      `payment_method:          ${woo?.payment_method ?? "—"}   (локально: ${o.paymentMethod ?? "—"})\n` +
      `payment_method_title:    ${woo?.payment_method_title ?? "—"}\n` +
      `transaction_id:          ${woo?.transaction_id?.trim() ? mask(woo.transaction_id) : "—"}\n` +
      `intent id (masked):      ${mask(intentId)}   [${WOO_INTENT_META_KEY}]\n` +
      `Airwallex meta найдено:  ${relevantMeta(woo?.meta_data).join("; ") || "—"}\n` +
      `firstSeenAt:             ${firstSeenAt.toISOString()}  (${fromNow ? "сейчас, override --from-now" : "дата заказа"})\n` +
      `stopCheckingAt:          ${stopAt.toISOString()}${expired ? "  ← ИСТЁК" : ""}\n` +
      `nextCheckAt:             ${blocked ? "—" : `${now.toISOString()} (сразу)`}\n` +
      `запись мониторинга:      ${probe ? "не создаётся (probe — только чтение)" : blocked ? `НЕ будет — ${blocked}` : live ? "создаётся сейчас" : "БУДЕТ создана (dry-run: не создана)"}`
    );

    // PROBE: единственное место, где скрипт обращается в Airwallex. Только чтение статуса.
    if (probe) {
      if (!intentId) { console.log(`статус в Airwallex:      не запрошен — нет intent id`); continue; }
      const creds = await resolveAirwallexCreds(prisma, site.id);
      if (!creds) { console.log(`статус в Airwallex:      не запрошен — креды не настроены`); continue; }
      const pi = await new AirwallexClient(creds).getPaymentIntent(intentId);
      if (!pi.ok) {
        console.log(`статус в Airwallex:      ОШИБКА ЗАПРОСА (${pi.code})`);
      } else if (!pi.found) {
        console.log(`статус в Airwallex:      intent НЕ НАЙДЕН (404) → NOT_FOUND`);
      } else {
        console.log(
          `статус в Airwallex:      ${pi.rawStatus}  →  нормализовано: ${normalize(pi.rawStatus, pi.latestAttemptStatus)}\n` +
          `  последняя попытка:     ${mask(pi.latestAttemptId)} status=${pi.latestAttemptStatus ?? "—"}\n` +
          `  суммы:                 amount=${pi.amount ?? "—"} captured=${pi.capturedAmount ?? "—"} ${pi.currency ?? ""}`
        );
      }
      continue;
    }

    if (blocked || !live || !intentId) continue;

    const r = await upsertAirwallexPayment(prisma, {
      orderId: o.id, siteId: site.id, paymentIntentId: intentId, paymentMethod: o.paymentMethod, firstSeenAt,
    });
    created += r.created ? 1 : 0;
    console.log(`→ создано: ${r.created}`);
  }

  console.log(`\n=== Итог (${mode}): создано записей ${live ? created : 0} ===`);
  if (probe) console.log("Это был probe: БД не изменена, Telegram не отправлялся, мониторинг не заведён.");
  else if (!live) console.log("Это был dry-run: БД не изменена, в Airwallex не ходили. Для записи: --live --confirm");
  else console.log("Сверку выполнит диспетчер воркера в течение 5 минут (один запрос в Airwallex на заказ).");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("ОШИБКА:", e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
