import "server-only";
/**
 * Сборка конфигурации ingest (payment classification + meta mapping) из WooCommerceConnection.
 * Ничего не хардкодим — всё берём из настроек конкретного Site.
 */
import { prisma } from "@/lib/db";
import type { WooIngestConfig } from "./ingestWooOrder";
import type { AirwallexMetaConfig, WooPaymentConfig } from "./payment";
import type { OrderMetaMapping } from "./orderMeta";

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Загружает и валидирует конфиг ingest для Site. Бросает, если подключения нет. */
export async function loadWooIngestConfig(siteId: string): Promise<WooIngestConfig> {
  const c = await prisma.wooCommerceConnection.findUnique({
    where: { siteId },
    select: {
      airwallexEnabled: true,
      klarnaPayLaterPendingIsConfirmed: true,
      airwallexPaymentMethodIds: true,
      airwallexMetaKeys: true,
      payLaterMaxWaitMinutes: true,
      unknownBehavior: true,
      orderMetaMapping: true,
    },
  });
  if (!c) throw new Error(`WooCommerceConnection не найден для site ${siteId}`);

  const payment: WooPaymentConfig = {
    airwallexEnabled: c.airwallexEnabled,
    klarnaPayLaterPendingIsConfirmed: c.klarnaPayLaterPendingIsConfirmed,
    airwallexPaymentMethodIds: asStringArray(c.airwallexPaymentMethodIds),
    airwallexMetaKeys: (c.airwallexMetaKeys as AirwallexMetaConfig | null) ?? null,
    payLaterMaxWaitMinutes: c.payLaterMaxWaitMinutes,
    unknownBehavior: c.unknownBehavior === "AWAITING_PAYMENT" ? "AWAITING_PAYMENT" : "HOLD",
  };

  return { payment, orderMetaMapping: (c.orderMetaMapping as OrderMetaMapping | null) ?? null };
}
