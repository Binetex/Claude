import "server-only";
/**
 * Идемпотентная запись WooCommerce-заказа в БД. Один заказ = одна строка Order (upsert по
 * siteId+externalId, без дублей). Учитывает:
 *  - классификацию платежа (Airwallex/Klarna BNPL) → paymentStatus/workable;
 *  - out-of-order защиту по date_modified_gmt (externalUpdatedAt);
 *  - anti-rollback внутренних рабочих/терминальных статусов;
 *  - сохранение локальных полей Floremart (florist/цены/составы/заметки/tracking — не трогаем);
 *  - сопоставление позиций по variation_id → product_id (SKU/title не ключи).
 *
 * НЕ дублирует Shopify-путь и НЕ меняет его — это отдельный writer для платформенных
 * особенностей WooCommerce (payment classification, meta mapping).
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { parseWooOrder, type WooOrder } from "./orderAdapter";
import { classifyWooPayment, type WooPaymentConfig, type WooOrderForPayment } from "./payment";
import { deriveWooOrderState, reconcileOrderState, type OrderState } from "./orderState";
import { resolveMappedOrderFields, type OrderMetaMapping } from "./orderMeta";
import { scheduleDeliveryForNewOrder } from "@/integrations/delivery/burq/scheduleService";
import { assignInitial } from "@/modules/assignments/service";
import { publishOrderCreatedTrigger, scheduleDeliveryTodayTrigger, publishPaymentStateTrigger } from "@/modules/automations/lifecycle";
import { paymentTriggerFor } from "@/modules/automations/paymentTriggers";

/**
 * Авто-назначение основного флориста при переходе заказа в CONFIRMED (оплачен / в работу) —
 * зеркалит поведение Shopify-ingest. Идемпотентно (assignInitial не переназначает уже назначенный
 * заказ) и срабатывает только на ПЕРЕХОДЕ в CONFIRMED, а не на каждом обновлении. Best-effort:
 * сбой назначения не ломает приём заказа.
 */
async function autoAssignWooIfConfirmed(orderId: string, prev: OrderState | null, next: OrderState): Promise<void> {
  const becameConfirmed = next.orderStatus === "CONFIRMED" && (!prev || prev.orderStatus !== "CONFIRMED");
  if (!becameConfirmed) return;
  try {
    await assignInitial(orderId);
  } catch (e) {
    console.error(`[assign] авто-назначение WooCommerce заказа ${orderId} не удалось:`, e instanceof Error ? e.message : String(e));
  }
}

export type WooIngestConfig = {
  payment: WooPaymentConfig;
  orderMetaMapping: OrderMetaMapping | null;
};

type WooLineItem = {
  id?: number | string;
  product_id?: number | string;
  variation_id?: number | string;
  name?: string;
  sku?: string;
  quantity?: number;
  price?: number | string;
  total?: string | number;
};
type FullWooOrder = WooOrder &
  WooOrderForPayment & {
    date_modified_gmt?: string;
    line_items?: WooLineItem[];
    total?: string | number;
    total_tax?: string | number;
    shipping_total?: string | number;
    discount_total?: string | number;
  };

/**
 * Адрес отправителя (billing) WooCommerce → поля senderAddress* заказа. Внешние данные
 * (не локальные), поэтому переносим как есть и обновляем при ресинке — как в Shopify-ingest.
 */
function wooSenderAddressFields(billing: FullWooOrder["billing"]) {
  return {
    senderAddressLine: billing?.address_1?.trim() || null,
    senderApartment: billing?.address_2?.trim() || null,
    senderCity: billing?.city?.trim() || null,
    senderProvince: billing?.state?.trim() || null,
    senderZip: billing?.postcode?.trim() || null,
    senderCountry: billing?.country?.trim() || null,
  };
}

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(Number.isFinite(n) ? n : 0);
const money = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

function parseGmt(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const s = iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Строит карту каталога сайта: вариант по externalId и товар по externalId. */
async function loadCatalogMatch(siteId: string) {
  const products = await prisma.product.findMany({
    where: { siteId },
    select: { id: true, externalId: true, image: true, variants: { select: { id: true, externalId: true, image: true, floristComposition: true } } },
  });
  const productByExt = new Map<string, { id: string; image: string | null }>();
  // Товар по нашему id — чтобы при ненайденном product_id взять РОДИТЕЛЬСКОЕ фото товара
  // варианта, а не фото самого варианта.
  const productById = new Map<string, { id: string; image: string | null }>();
  const variantByExt = new Map<string, { id: string; image: string | null; floristComposition: string | null; productId: string }>();
  for (const p of products) {
    productByExt.set(p.externalId, { id: p.id, image: p.image });
    productById.set(p.id, { id: p.id, image: p.image });
    for (const v of p.variants) variantByExt.set(v.externalId, { id: v.id, image: v.image, floristComposition: v.floristComposition, productId: p.id });
  }
  return { productByExt, productById, variantByExt };
}

/**
 * Приём/обновление одного WooCommerce-заказа. Возвращает результат для логов/метрик.
 * `now`-независим по решениям (кроме предупреждений о зависшем pending внутри классификатора).
 */
export async function ingestWooOrder(
  site: { id: string; shortName: string },
  wooOrder: FullWooOrder,
  config: WooIngestConfig,
  // emitLifecycle: публиковать ли trigger-события авто-SMS (ORDER_CREATED). ТОЛЬКО для «живого»
  // webhook; при bulk-sync/backfill истории — false (по умолчанию), чтобы не слать SMS по старым заказам.
  opts: { emitLifecycle?: boolean } = {}
): Promise<{ status: "created" | "updated" | "skipped_stale"; orderId: string | null; classification: string }> {
  const externalId = String(wooOrder.id);
  const normalized = parseWooOrder(wooOrder);
  const mapped = resolveMappedOrderFields(wooOrder.meta_data, config.orderMetaMapping);
  const payment = classifyWooPayment(wooOrder, config.payment);
  const incomingState: OrderState = deriveWooOrderState(wooOrder.status ?? "pending", payment);
  const externalUpdatedAt = parseGmt(wooOrder.date_modified_gmt) ?? parseGmt(wooOrder.date_created_gmt);

  const existing = await prisma.order.findFirst({
    where: { siteId: site.id, externalId },
    select: { id: true, orderStatus: true, paymentStatus: true, externalUpdatedAt: true, paymentClassification: true, deliveryDate: true },
  });

  // Out-of-order guard: пришедшее событие старше уже применённого — пропускаем.
  if (existing && externalUpdatedAt && existing.externalUpdatedAt && externalUpdatedAt < existing.externalUpdatedAt) {
    return { status: "skipped_stale", orderId: existing.id, classification: payment.classification };
  }

  // Данные обновления: ТОЛЬКО внешне-производные поля (локальные florist/цены/составы/заметки/
  // tracking НЕ трогаем). reconciled — с anti-rollback относительно текущего состояния.
  const externalUpdateData = (reconciled: OrderState) => ({
    orderStatus: reconciled.orderStatus,
    paymentStatus: reconciled.paymentStatus,
    externalStatus: wooOrder.status ?? null,
    paymentMethod: wooOrder.payment_method ?? null,
    paymentMethodTitle: wooOrder.payment_method_title ?? null,
    paymentClassification: payment.classification,
    paymentWarning: payment.warning,
    externalUpdatedAt: externalUpdatedAt ?? undefined,
    remoteDeleted: false,
    deletedAt: null,
    lastSyncedAt: new Date(),
    syncStatus: "SYNCED" as const,
    // Адрес отправителя (billing) — внешние данные, подтягиваем и при ресинке (как в Shopify).
    ...wooSenderAddressFields(wooOrder.billing),
    // Чаевые (Fees) — внешние данные, обновляем при ресинке (исправляет старые заказы с tip=0).
    tip: dec(normalized.money.tip),
  });
  const applyUpdate = async (id: string, cur: OrderState): Promise<OrderState> => {
    const reconciled = reconcileOrderState(cur, incomingState, wooOrder.status ?? "pending");
    await prisma.order.update({ where: { id }, data: externalUpdateData(reconciled) });
    return reconciled;
  };

  // ── UPDATE существующего.
  if (existing) {
    const prev: OrderState = { orderStatus: existing.orderStatus, paymentStatus: existing.paymentStatus };
    const reconciled = await applyUpdate(existing.id, prev);
    await autoAssignWooIfConfirmed(existing.id, prev, reconciled);
    if (opts.emitLifecycle) {
      // Триггеры оплаты — строго на ПЕРЕХОДЕ состояния, иначе каждый resync слал бы повтор.
      const trigger = paymentTriggerFor(payment, reconciled.paymentStatus);
      const prevTrigger = paymentTriggerFor(
        { classification: existing.paymentClassification, payLater: payment.payLater },
        existing.paymentStatus
      );
      if (trigger && trigger !== prevTrigger) {
        await publishPaymentStateTrigger(prisma, { orderId: existing.id, siteId: site.id, triggerType: trigger });
      }
      // Дата доставки могла измениться — планируем «доставку сегодня» на актуальный день.
      await scheduleDeliveryTodayTrigger(prisma, existing.id);
    }
    return { status: "updated", orderId: existing.id, classification: payment.classification };
  }

  // ── CREATE.
  const { productByExt, productById, variantByExt } = await loadCatalogMatch(site.id);
  const resolveMatch = (li: WooLineItem) => {
    const variant = li.variation_id ? variantByExt.get(String(li.variation_id)) : undefined;
    // simple-товар: синтетический вариант имеет externalId = product_id.
    const variantFallback = !variant && li.product_id ? variantByExt.get(String(li.product_id)) : undefined;
    const v = variant ?? variantFallback;
    // Товар не нашёлся по product_id → берём родителя варианта (с ЕГО фото, не фото варианта).
    const product = (li.product_id ? productByExt.get(String(li.product_id)) : undefined) ?? (v ? productById.get(v.productId) : undefined);
    return { v, product };
  };

  const deliveryDate = mapped.deliveryDate ? new Date(mapped.deliveryDate) : normalized.deliveryDate ? new Date(normalized.deliveryDate) : new Date(normalized.createdAt);
  const cardMessage = mapped.cardMessage ?? normalized.cardMessage ?? "";
  const recipientName = mapped.recipientName ?? normalized.recipient.name;
  const recipientPhone = mapped.recipientPhone ?? normalized.recipient.phone ?? "";
  const addr = normalized.shippingAddress;
  const items: WooLineItem[] = (wooOrder.line_items ?? []) as WooLineItem[];

  let created: { id: string };
  try {
    created = await prisma.order.create({
    data: {
      orderNumber: `${site.shortName}-${normalized.externalNumber ?? externalId}`,
      siteId: site.id,
      platform: "WOOCOMMERCE",
      source: "WooCommerce",
      externalId,
      externalCreatedAt: new Date(normalized.createdAt),
      externalUpdatedAt: externalUpdatedAt ?? undefined,
      deliveryDate,
      deliveryWindow: mapped.deliveryWindow ?? normalized.deliveryWindow ?? "",
      senderName: mapped.senderName ?? normalized.sender.name,
      senderPhone: normalized.sender.phone ?? "",
      senderEmail: normalized.sender.email,
      ...wooSenderAddressFields(wooOrder.billing),
      recipientName,
      recipientPhone,
      recipientEmail: normalized.recipient.email,
      addressLine: addr?.line1 ?? "",
      apartment: mapped.apartment ?? addr?.line2 ?? null,
      city: addr?.city ?? "",
      zip: addr?.zip ?? "",
      cardMessage,
      originalCardMessage: cardMessage,
      customerNote: mapped.deliveryInstructions ?? "",
      originalCustomerNote: mapped.deliveryInstructions ?? "",
      itemsTotal: dec(normalized.money.itemsTotal),
      tax: dec(normalized.money.tax),
      tip: dec(normalized.money.tip), // WooCommerce Fees = чаевые
      discount: dec(normalized.money.discount),
      deliveryCustomerCost: dec(normalized.money.deliveryCost),
      customerTotal: dec(normalized.money.total),
      paymentStatus: incomingState.paymentStatus,
      orderStatus: incomingState.orderStatus,
      externalStatus: wooOrder.status ?? null,
      paymentMethod: wooOrder.payment_method ?? null,
      paymentMethodTitle: wooOrder.payment_method_title ?? null,
      paymentClassification: payment.classification,
      paymentWarning: payment.warning,
      syncStatus: "SYNCED",
      lastSyncedAt: new Date(),
      items: {
        create: items.map((li) => {
          const { v, product } = resolveMatch(li);
          const variantName = normalized.items.find((n) => n.externalId === (li.id != null ? String(li.id) : null))?.variantName ?? null;
          return {
            productId: product?.id ?? v?.productId ?? null,
            variantId: v?.id ?? null,
            productExternalId: li.product_id != null ? String(li.product_id) : null,
            variantExternalId: li.variation_id ? String(li.variation_id) : null,
            name: li.name ?? "—",
            variantName,
            sku: li.sku?.trim() || null,
            options: variantName ?? "",
            quantity: li.quantity ?? 1,
            externalPrice: dec(money(li.price ?? li.total)),
            // image — прежнее «эффективное» фото (legacy, совместимость); parent/variant — раздельно.
            image: v?.image ?? product?.image ?? null,
            parentImageUrl: product?.image ?? null,
            variantImageUrl: v?.image ?? null,
            floristCompositionSnapshot: v?.floristComposition ?? null,
          };
        }),
      },
    },
    select: { id: true },
    });
  } catch (err) {
    // Гонка create (webhook + sync параллельно нарушили @@unique[siteId,externalId]) — заказ
    // уже создан другим потоком; находим его и обновляем (без дубля).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const race = await prisma.order.findFirst({ where: { siteId: site.id, externalId }, select: { id: true, orderStatus: true, paymentStatus: true } });
      if (race) {
        const prev: OrderState = { orderStatus: race.orderStatus, paymentStatus: race.paymentStatus };
        const reconciled = await applyUpdate(race.id, prev);
        await autoAssignWooIfConfirmed(race.id, prev, reconciled);
        return { status: "updated", orderId: race.id, classification: payment.classification };
      }
    }
    throw err;
  }
  // Авто-назначение основного флориста для нового оплаченного заказа (как в Shopify-ingest).
  await autoAssignWooIfConfirmed(created.id, null, incomingState);
  // Единый вызов планировщика доставки после сохранения заказа (best-effort — не ломаем импорт).
  try {
    await scheduleDeliveryForNewOrder(prisma, created.id);
  } catch (e) {
    console.error(`[burq] не удалось запланировать доставку для заказа ${created.id}:`, e instanceof Error ? e.message : String(e));
  }
  // Авто-SMS: ORDER_CREATED только для нового заказа из ЖИВОГО webhook (не bulk-sync/backfill).
  if (opts.emitLifecycle) {
    await publishOrderCreatedTrigger(prisma, { orderId: created.id, siteId: site.id });
    await scheduleDeliveryTodayTrigger(prisma, created.id);
    const trigger = paymentTriggerFor(payment, incomingState.paymentStatus);
    if (trigger) await publishPaymentStateTrigger(prisma, { orderId: created.id, siteId: site.id, triggerType: trigger });
  }
  return { status: "created", orderId: created.id, classification: payment.classification };
}

/** Мягкая архивация заказа при order.deleted / trash: физически НЕ удаляем. */
export async function markWooOrderDeleted(siteId: string, externalId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { siteId, externalId, remoteDeleted: false },
    data: { remoteDeleted: true, deletedAt: new Date(), externalStatus: "trash" },
  });
}
