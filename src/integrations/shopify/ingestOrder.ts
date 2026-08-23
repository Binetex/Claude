import "server-only";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { PaymentStatus } from "@/generated/prisma/enums";
import { assignInitial } from "@/modules/assignments/service";
import { indexByExternalId } from "@/modules/catalog/matchIndex";
import { createProductImageCache, resolveLineItemImages, type ProductImageCache } from "./productImages";
import { resolveShopifyAccessToken } from "./customApp/credentials";
import { normalizePhone } from "@/lib/phone";
import { cleanCardMessage } from "@/integrations/cardMessageTail";
import { scheduleDeliveryForNewOrder } from "@/integrations/delivery/burq/scheduleService";
import { extractShopifyOrderNumber, extractSenderAddress, extractSenderIdentity } from "./orderFields";
import { fetchShopifyDeliveryInstructions } from "./deliveryInstructions";
import { utcMidnightOfLocalDay, parseLocalDayToUtcMidnight } from "@/lib/tz";
import {
  publishOrderCreatedTrigger,
  scheduleDeliveryTodayTrigger,
  publishPaymentStateTrigger,
  publishOrderLifecycleTriggers,
} from "@/modules/automations/lifecycle";
import { deriveShopifyOrderState, reconcileShopifyUpdate, type ShopifyStateSignal } from "./orderState";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { adoptOrphanCommunicationsForNewOrder } from "@/integrations/quo/adoptOrphans";
import { displayVariantName } from "@/lib/variantName";

/** Планирование доставки, безопасное для импорта: ошибка логируется, но не роняет приём заказа. */
async function scheduleDeliverySafe(orderId: string): Promise<void> {
  try {
    await scheduleDeliveryForNewOrder(prisma, orderId);
  } catch (err) {
    console.error(`[burq] не удалось запланировать доставку для заказа ${orderId}:`, err instanceof Error ? err.message : String(err));
  }
}

// timezone нужен, чтобы вывести день доставки из даты заказа, когда её нет в note_attributes.
type Site = { id: string; shortName: string; shopifyShopDomain: string | null; shopifyAccessToken: string | null; timezone?: string | null };

type ShopifyMoney = string | null | undefined;
type ShopifyAddress = {
  name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province_code?: string;
  province?: string;
  zip?: string;
  country_code?: string;
} | null;

type ShopifyLineItem = {
  title: string;
  variant_title?: string | null;
  sku?: string | null;
  quantity: number;
  price: ShopifyMoney;
  product_id?: number | string | null;
  variant_id?: number | string | null;
};

type ShopifyNoteAttribute = { name?: string; value?: string };

export type ShopifyOrder = {
  id: number | string;
  order_number?: number;
  name?: string;
  email?: string | null;
  contact_email?: string | null;
  /** Телефон уровня заказа — то, что клиент ввёл на оформлении. Приоритетный для заказчика. */
  phone?: string | null;
  note?: string | null;
  note_attributes?: ShopifyNoteAttribute[];
  financial_status?: string | null;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  created_at?: string;
  updated_at?: string;
  customer?: { first_name?: string; last_name?: string; phone?: string } | null;
  billing_address?: ShopifyAddress;
  shipping_address?: ShopifyAddress;
  line_items?: ShopifyLineItem[];
  subtotal_price?: ShopifyMoney;
  total_price?: ShopifyMoney;
  total_tax?: ShopifyMoney;
  total_tip_received?: ShopifyMoney;
  total_discounts?: ShopifyMoney;
  total_shipping_price_set?: { shop_money?: { amount?: ShopifyMoney } };
};

const money = (v: ShopifyMoney): Prisma.Decimal => new Prisma.Decimal(v && v.length > 0 ? v : "0");

function findNoteAttribute(order: ShopifyOrder, pattern: RegExp): string | undefined {
  return order.note_attributes?.find((a) => a.name && pattern.test(a.name))?.value;
}

function fullName(a: ShopifyAddress | null | undefined): string {
  if (!a) return "";
  if (a.name) return a.name;
  return [a.first_name, a.last_name].filter(Boolean).join(" ").trim();
}

function mapPaymentStatus(financialStatus: string | null | undefined): PaymentStatus {
  if (financialStatus === "paid") return "PAID";
  if (financialStatus === "refunded") return "REFUNDED";
  if (financialStatus === "partially_refunded") return "PARTIALLY_REFUNDED";
  return "UNPAID";
}

/** Срез payload, от которого зависит статус (деривация и anti-rollback — в orderState.ts). */
function stateSignal(payload: ShopifyOrder): ShopifyStateSignal {
  return { cancelledAt: payload.cancelled_at, fulfillmentStatus: payload.fulfillment_status };
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Адрес получателя и текст открытки — поля, которые Shopify реально позволяет менять
 * через Admin API и после создания заказа (shipping_address, note), поэтому они у нас
 * двусторонние (см. pushUpdate.ts).
 *
 * ВАЖНО: у этого магазина (O'hara Florist) текст открытки клиенты всегда пишут в
 * стандартное поле заказа Shopify "note" (то же самое, что в Shopify называется Customer
 * note в интерфейсе) — отдельного note_attribute под открытку тема магазина не использует.
 * Поэтому cardMessage = payload.note, а НЕ note_attributes. customerNote для Shopify-заказов
 * остаётся пустым — отдельного поля под "заметку клиента" (в нашем, floremart-смысле) у
 * этого магазина нет; поле customerNote при этом остаётся обычным редактируемым полем
 * для владельца/колл-центра (как раньше), просто Shopify его не наполняет.
 *
 * deliveryDate/deliveryWindow по-прежнему парсятся из note_attributes отдельно в
 * buildOrderData — то поле Shopify не даёт менять post-creation вообще, поэтому для них
 * push не существует и resync на update не делается.
 *
 * Из note срезается служебный хвост приложения доставки («| Delivery Date: … | Delivery
 * Time: …») и раскрываются HTML-сущности («&amp;» → «&») — см. cardMessageTail.ts. К
 * поздравлению это не относится: дата и окно и так лежат в своих полях заказа.
 * Сырой note сохраняется в originalCardMessage.
 */
function extractAddressAndCardMessage(payload: ShopifyOrder) {
  const note = payload.note ?? "";
  return {
    recipientName: fullName(payload.shipping_address) || "—",
    recipientPhone: normalizePhone(payload.shipping_address?.phone),
    addressLine: payload.shipping_address?.address1 ?? "",
    apartment: payload.shipping_address?.address2 ?? null,
    city: payload.shipping_address?.city ?? "",
    zip: payload.shipping_address?.zip ?? "",
    cardMessage: cleanCardMessage(note),
    rawNote: note,
  };
}

/**
 * Обновление уже существующего заказа при повторном вебхуке (orders/updated или
 * повторный orders/create). Синхронизирует статус оплаты/заказа плюс адрес получателя
 * и текст открытки — они действительно двусторонние поля Shopify (см.
 * extractAddressAndCardMessage). customerNote/deliveryDate/deliveryWindow НЕ трогаем:
 * customerNote — это ручное поле владельца/колл-центра, Shopify им не управляет;
 * deliveryDate/deliveryWindow — Shopify не позволяет их менять после создания заказа
 * (note_attributes), поэтому push для них не существует и подтягивать здесь то же самое
 * неизменное значение бессмысленно.
 */
async function applyUpdateFromShopify(
  site: Site,
  existing: { id: string; paymentStatus: string; orderStatus: string },
  payload: ShopifyOrder,
  paymentStatus: PaymentStatus
): Promise<void> {
  const wasUnpaid = existing.paymentStatus !== "PAID";
  const { recipientName, recipientPhone, addressLine, apartment, city, zip, cardMessage } = extractAddressAndCardMessage(payload);
  const externalId = String(payload.id);
  // Номер (из name), адрес отправителя (billing) и инструкции доставки подтягиваем заново — как и
  // адрес получателя, это неручные поля из Shopify; при resync их НЕ обнуляем (billing пустой → null,
  // но Shopify его почти всегда присылает). deliveryInstructions best-effort (см. createNewOrder).
  const senderAddress = extractSenderAddress(payload.billing_address);
  // Имя и телефон заказчика подтягиваем заново вместе с его адресом: это такие же неручные
  // поля Shopify, и без них повторный вебхук не исправил бы заказ, принятый по старому
  // правилу «billing важнее customer».
  const senderIdentity = extractSenderIdentity(payload);
  const deliveryInstructions = await fetchShopifyDeliveryInstructions(site.id, externalId);
  // Возврат — платформо-независимый переход (financial_status=refunded → paymentStatus REFUNDED),
  // в отличие от pending/failed, которые Shopify не различает. Публикуем строго на ПЕРЕХОДЕ.
  const becameRefunded = paymentStatus === "REFUNDED" && existing.paymentStatus !== "REFUNDED";
  // Статус заказа на update: только терминальные факты платформы (отменён/выполнен) плюс
  // «оплатили ожидающий заказ» — внутренние рабочие этапы не затираем (см. orderState.ts).
  const stateUpdate = reconcileShopifyUpdate(existing, stateSignal(payload), paymentStatus);
  await prisma.order.update({
    where: { id: existing.id },
    data: {
      orderNumber: `${site.shortName}-${extractShopifyOrderNumber(payload.name, payload.order_number, externalId)}`,
      paymentStatus,
      orderStatus: stateUpdate.orderStatus,
      ...(stateUpdate.deliveryStatus ? { deliveryStatus: stateUpdate.deliveryStatus } : {}),
      syncStatus: "SYNCED",
      lastSyncedAt: new Date(),
      recipientName,
      recipientPhone,
      addressLine,
      apartment,
      city,
      zip,
      cardMessage,
      ...senderIdentity,
      ...senderAddress,
      ...(deliveryInstructions ? { deliveryInstructions } : {}),
    },
  });
  if (wasUnpaid && paymentStatus === "PAID") {
    await assignInitial(existing.id);
  }
  if (becameRefunded) {
    await publishPaymentStateTrigger(prisma, { orderId: existing.id, siteId: site.id, triggerType: "ORDER_REFUNDED" });
  }
  // Lifecycle-триггеры строго по фактическому переходу: повторный orders/updated с тем же
  // состоянием (Shopify шлёт их щедро) ничего не публикует.
  await publishOrderLifecycleTriggers(prisma, {
    orderId: existing.id,
    siteId: site.id,
    prev: { orderStatus: existing.orderStatus, paymentStatus: existing.paymentStatus },
    next: { orderStatus: stateUpdate.orderStatus ?? existing.orderStatus, paymentStatus },
  });
}

/**
 * Обрабатывает вебхук заказа Shopify: идемпотентно создаёт/обновляет Order,
 * запускает авто-назначение флориста для новых оплаченных заказов.
 *
 * При повторных вебхуках (orders/updated) адрес получателя и текст открытки
 * подтягиваются заново из Shopify (см. applyUpdateFromShopify) — это действительно
 * двусторонние поля (owner тоже может их поправить в Floremart, см. pushUpdate.ts).
 * customerNote для Shopify-заказов не заполняется автоматически вообще (см.
 * extractAddressAndCardMessage) — меняется только вручную владельцем/колл-центром.
 *
 * Идемпотентность реализована через "создать, а при конфликте — обновить" (а не
 * "проверить, потом создать"): Shopify нередко присылает orders/create и
 * orders/updated почти одновременно для одного заказа, и предварительная проверка
 * findFirst+create race'ится — оба запроса не видят ещё не закоммиченную запись
 * друг друга и оба пытаются создать. Уникальность (siteId, externalId) в БД —
 * источник истины, а не наша проверка перед записью.
 */
export async function ingestShopifyOrder(
  topic: string,
  shopDomain: string,
  payload: ShopifyOrder
): Promise<void> {
  const site = await prisma.site.findUnique({ where: { shopifyShopDomain: shopDomain } });
  if (!site) {
    console.warn(`[shopify] вебхук для неизвестного магазина ${shopDomain}, пропуск`);
    return;
  }

  const externalId = String(payload.id);

  if (topic === "orders/cancelled") {
    const existing = await prisma.order.findFirst({
      where: { siteId: site.id, externalId },
      select: { id: true, orderStatus: true, paymentStatus: true },
    });
    if (!existing) return;
    // Повторный orders/cancelled по уже отменённому заказу — ни записи, ни триггера.
    if (existing.orderStatus === "CANCELLED") return;
    await prisma.order.update({ where: { id: existing.id }, data: { orderStatus: "CANCELLED" } });
    await publishOrderLifecycleTriggers(prisma, {
      orderId: existing.id,
      siteId: site.id,
      prev: { orderStatus: existing.orderStatus, paymentStatus: existing.paymentStatus },
      next: { orderStatus: "CANCELLED", paymentStatus: existing.paymentStatus },
    });
    return;
  }

  const paymentStatus = mapPaymentStatus(payload.financial_status);

  try {
    const order = await createNewOrder(site, externalId, payload, paymentStatus, createProductImageCache());
    // Назначаем флориста только активным заказам (оплачен, не выполнен/не отменён).
    if (order.orderStatus === "CONFIRMED") {
      await assignInitial(order.id);
    }
    // Единый вызов планировщика доставки после сохранения заказа (best-effort — не ломаем приём).
    await scheduleDeliverySafe(order.id);
    // Авто-SMS: триггер ORDER_CREATED только для НОВОГО заказа (не update/resync/backfill).
    await publishOrderCreatedTrigger(prisma, { orderId: order.id, siteId: site.id });
    // Клиент мог написать/позвонить ДО того, как заказ дошёл до нас — такое событие осталось
    // сиротой. Даём матчингу второй шанс (best-effort, свои ошибки глотает).
    await adoptOrphanCommunicationsForNewOrder(prisma, order.id);
    // «Заказ оплачен» — заказ пришёл к нам уже оплаченным (обычный путь Shopify). ORDER_DELIVERED/
    // ORDER_CANCELLED на создании не публикуются: это импорт факта, а не наблюдённый переход.
    await publishOrderLifecycleTriggers(prisma, {
      orderId: order.id,
      siteId: site.id,
      prev: null,
      next: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus },
    });
    // «Доставка сегодня» — платформо-независимый триггер, планируется и для Shopify.
    await scheduleDeliveryTodayTrigger(prisma, order.id);
    // Владельцу — о любом новом заказе. Только здесь: backfillShopifyOrder этот путь не проходит.
    await publishTelegramNotification(prisma, {
      type: "order.created", orderId: order.id, occurrenceKey: order.id,
      context: { paymentLabel: paymentStatus },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    const existing = await prisma.order.findFirst({ where: { siteId: site.id, externalId } });
    if (!existing) throw err; // конфликт по другой причине (например, orderNumber) — пробрасываем дальше
    await applyUpdateFromShopify(site, existing, payload, paymentStatus);
  }
}

/**
 * Собирает данные заказа из Shopify-payload в форму, готовую для `prisma.order.create`.
 * Общий маппинг для вебхука (`createNewOrder`) и разового backfill-скрипта
 * (`backfillShopifyOrder`) — открытка/заметка/суммы/позиции не должны разъезжаться
 * между двумя путями создания заказа.
 */
function buildOrderData(
  site: Site,
  externalId: string,
  payload: ShopifyOrder,
  paymentStatus: PaymentStatus,
  catalog: CatalogMatch,
  live: { images: Map<string, string> },
  deliveryInstructions: string,
  extra?: { isBackfilled?: boolean }
) {
  const { recipientName, recipientPhone, addressLine, apartment, city, zip, cardMessage, rawNote } =
    extractAddressAndCardMessage(payload);
  const senderAddress = extractSenderAddress(payload.billing_address);
  const customerNote = ""; // у Shopify-заказов открытка всегда в payload.note — отдельного поля под заметку клиента нет
  const deliveryDateRaw = findNoteAttribute(payload, /delivery.*date/i);
  const deliveryWindow = findNoteAttribute(payload, /delivery.*(time|window)/i) ?? "";
  // Без явной даты доставки берём дату САМОГО ЗАКАЗА, но приводим её к виду, в котором поле
  // хранится, — UTC-полночь локального дня магазина. Сырой timestamp здесь давал вечерним
  // заказам (после 17:00 в Лос-Анджелесе — это уже следующие сутки UTC) день доставки на сутки
  // вперёд, со всеми последствиями: «доставка сегодня», списки дня, финансовый день.
  const parsedDeliveryDay = parseLocalDayToUtcMidnight(deliveryDateRaw);
  const deliveryDate =
    parsedDeliveryDay ?? utcMidnightOfLocalDay(new Date(payload.created_at ?? Date.now()), site.timezone);
  if (!parsedDeliveryDay) {
    // Неразобранная строка раньше давала Invalid Date и роняла приём заказа целиком.
    console.warn(
      `[shopify] заказ ${externalId}: дата доставки в note_attributes отсутствует или не разобрана (${deliveryDateRaw ?? "нет"}), использую дату заказа`
    );
  }

  const items = payload.line_items ?? [];

  // Сопоставление позиции: СНАЧАЛА вариант по variant_id, затем товар по product_id.
  // Наши внутренние id (productId/variantId) нужны для авто-цены флориста; внешние id,
  // название варианта и SKU сохраняются снимком в заказе. Если товар не импортирован —
  // позиция всё равно создаётся (со снимком из payload), цена флориста будет 0.
  const resolveMatch = (li: ShopifyLineItem) => {
    const variant = li.variant_id ? catalog.variantByExt.get(String(li.variant_id)) : undefined;
    const product =
      (li.product_id ? catalog.productByExt.get(String(li.product_id)) : undefined) ?? variant?.product;
    return { variant, product };
  };
  // Фото родительского товара: каталог → live-фолбэк по product_id.
  const resolveParentImage = (li: ShopifyLineItem): string | null => {
    const { product } = resolveMatch(li);
    if (product?.image) return product.image;
    return (li.product_id != null ? live.images.get(String(li.product_id)) : undefined) ?? null;
  };
  // Фото конкретной вариации: только собственное фото варианта (каталог → live по variant_id).
  // Без фолбэка на товар — отсутствие фото у вариации значимо и означает «показывать родительское».
  const resolveVariantImage = (li: ShopifyLineItem): string | null => {
    const { variant } = resolveMatch(li);
    if (variant?.image) return variant.image;
    return (li.variant_id != null ? live.images.get(String(li.variant_id)) : undefined) ?? null;
  };
  /** LEGACY «эффективное» фото — прежнее поведение, чтобы старая колонка не меняла смысл. */
  const resolveImage = (li: ShopifyLineItem): string | null => resolveVariantImage(li) ?? resolveParentImage(li);
  // Снимок состава букета берётся ТОЛЬКО из сопоставленного варианта (не Shopify description,
  // не defaultFloristComposition товара). Если состав не задан — null.
  const resolveComposition = (li: ShopifyLineItem): string | null => {
    const { variant } = resolveMatch(li);
    return variant?.floristComposition ?? null;
  };
  const itemsTotal = money(payload.subtotal_price);
  const customerTotal = money(payload.total_price);
  const tax = money(payload.total_tax);
  const tip = money(payload.total_tip_received);
  const discount = money(payload.total_discounts);
  const deliveryCustomerCost = money(payload.total_shipping_price_set?.shop_money?.amount);

  const orderNumber = `${site.shortName}-${extractShopifyOrderNumber(payload.name, payload.order_number, externalId)}`;
  const { orderStatus, deliveryStatus } = deriveShopifyOrderState(stateSignal(payload), paymentStatus);

  return {
    orderNumber,
    siteId: site.id,
    platform: "SHOPIFY" as const,
    source: "Shopify",
    externalId,
    externalCreatedAt: payload.created_at ? new Date(payload.created_at) : new Date(),
    externalUpdatedAt: payload.updated_at ? new Date(payload.updated_at) : null,
    deliveryDate,
    deliveryWindow,
    // Личность заказчика — из customer, телефон по приоритету order.phone → customer.phone →
    // billing. Раньше здесь выигрывал billing и терял телефон заказчика (см. orderFields.ts).
    ...extractSenderIdentity(payload),
    senderEmail: payload.email ?? payload.contact_email ?? null,
    ...senderAddress,
    deliveryInstructions,
    recipientName,
    recipientPhone,
    recipientEmail: null,
    addressLine,
    apartment,
    city,
    zip,
    cardMessage,
    // Сырой note, вместе с хвостом приложения доставки: поле нигде не показывается и служит
    // следом того, что реально прислал магазин.
    originalCardMessage: rawNote,
    customerNote,
    originalCustomerNote: customerNote,
    itemsTotal,
    tax,
    tip,
    discount,
    deliveryCustomerCost,
    customerTotal,
    paymentStatus,
    orderStatus,
    ...(deliveryStatus ? { deliveryStatus } : {}),
    syncStatus: "SYNCED" as const,
    lastSyncedAt: new Date(),
    isBackfilled: extra?.isBackfilled ?? false,
    items: {
      create: items.map((li) => {
        const { variant, product } = resolveMatch(li);
        const variantName = displayVariantName(li.variant_title || variant?.title);
        return {
          productId: product?.id ?? variant?.product?.id ?? null,
          variantId: variant?.id ?? null,
          productExternalId: li.product_id != null ? String(li.product_id) : null,
          variantExternalId: li.variant_id != null ? String(li.variant_id) : null,
          name: li.title,
          variantName,
          sku: li.sku?.trim() || variant?.sku || null,
          options: variantName ?? "",
          quantity: li.quantity,
          externalPrice: money(li.price),
          image: resolveImage(li),
          parentImageUrl: resolveParentImage(li),
          variantImageUrl: resolveVariantImage(li),
          floristCompositionSnapshot: resolveComposition(li),
        };
      }),
    },
  };
}

// Сопоставление позиций заказа с нашим импортированным каталогом. Вариант ищется по
// variant_id (в пределах сайта), товар — по product_id.
type MatchedVariant = {
  id: string;
  title: string;
  sku: string | null;
  image: string | null;
  floristComposition: string | null;
  product: { id: string; image: string | null };
};
type MatchedProduct = { id: string; image: string | null };
type CatalogMatch = {
  variantByExt: Map<string, MatchedVariant>;
  productByExt: Map<string, MatchedProduct>;
};

async function matchCatalog(siteId: string, payload: ShopifyOrder): Promise<CatalogMatch> {
  const lineItems = payload.line_items ?? [];
  const variantExtIds = [
    ...new Set(lineItems.map((li) => li.variant_id).filter((v): v is number | string => v != null).map(String)),
  ];
  const productExtIds = [
    ...new Set(lineItems.map((li) => li.product_id).filter((v): v is number | string => v != null).map(String)),
  ];

  const [variants, products] = await Promise.all([
    variantExtIds.length
      ? prisma.productVariant.findMany({
          where: { externalId: { in: variantExtIds }, product: { siteId } },
          select: {
            id: true,
            externalId: true,
            title: true,
            sku: true,
            image: true,
            floristComposition: true,
            remoteDeleted: true,
            lastSyncedAt: true,
            product: { select: { id: true, image: true } },
          },
        })
      : Promise.resolve([]),
    productExtIds.length
      ? prisma.product.findMany({
          where: { siteId, externalId: { in: productExtIds } },
          select: { id: true, externalId: true, image: true, remoteDeleted: true, lastSyncedAt: true },
        })
      : Promise.resolve([]),
  ]);

  // Дубли по одному внешнему id разрешает indexByExternalId: живая запись важнее
  // удалённой. Простая карта брала последнюю строку выборки — то есть случайную.
  return {
    variantByExt: indexByExternalId(variants),
    productByExt: indexByExternalId(products),
  };
}

/**
 * Живой fallback картинок из Shopify (требует scope read_products). Используется только если
 * позиция не сопоставилась с импортированным каталогом. Не бросает исключений — при отсутствии
 * домена/токена/scope возвращает пустую карту. Shopify description больше не запрашивается.
 */
async function fetchLiveImages(
  site: Site,
  payload: ShopifyOrder,
  imageCache: ProductImageCache
): Promise<{ images: Map<string, string> }> {
  // Credentials — через единый resolver: CUSTOM_APP получает token из tokenManager,
  // legacy — stored token. Никакого прямого чтения токена здесь.
  let shopDomain = site.shopifyShopDomain;
  let accessToken = site.shopifyAccessToken;
  if (!accessToken) {
    try {
      const c = await resolveShopifyAccessToken(site.id);
      shopDomain = c.shopDomain;
      accessToken = c.accessToken;
    } catch {
      return { images: new Map() }; // нет доступа — картинки просто не подтянутся (не роняем приём)
    }
  }
  if (!shopDomain || !accessToken) return { images: new Map() };
  const lineItems = payload.line_items ?? [];
  const images = await resolveLineItemImages(shopDomain, accessToken, lineItems, imageCache);
  return { images };
}

async function createNewOrder(
  site: Site,
  externalId: string,
  payload: ShopifyOrder,
  paymentStatus: PaymentStatus,
  imageCache: ProductImageCache,
  extra?: { isBackfilled?: boolean }
) {
  const catalog = await matchCatalog(site.id, payload);
  const live = await fetchLiveImages(site, payload, imageCache);
  // Инструкции доставки (native Local Delivery) — отдельный GraphQL-запрос (в REST их нет).
  // Best-effort: при отсутствии scope/ошибке вернётся "" и приём заказа не ломается.
  const deliveryInstructions = await fetchShopifyDeliveryInstructions(site.id, externalId);
  const data = buildOrderData(site, externalId, payload, paymentStatus, catalog, live, deliveryInstructions, extra);
  return prisma.order.create({ data });
}

/**
 * Разово подтягивает исторический заказ Shopify (backfill), которого ещё нет в БД.
 *
 * В отличие от вебхука (create-then-catch, см. docstring `ingestShopifyOrder`) прогон
 * backfill последовательный, не конкурентный — гонки между create/updated тут нет,
 * поэтому find-then-create безопасен.
 *
 * Идемпотентно на уровне повторного запуска скрипта: если заказ уже существует
 * (пришёл раньше через вебхук или предыдущий прогон backfill) — пропускаем, НЕ трогая
 * существующие данные (то же правило "не перезаписывать вручную поправленное", что и
 * в applySafeUpdate).
 */
export async function backfillShopifyOrder(
  site: Site,
  payload: ShopifyOrder,
  imageCache: ProductImageCache = createProductImageCache()
): Promise<{ status: "created" | "skipped"; orderId?: string }> {
  const externalId = String(payload.id);
  const existing = await prisma.order.findFirst({ where: { siteId: site.id, externalId } });
  if (existing) return { status: "skipped" };

  const paymentStatus = mapPaymentStatus(payload.financial_status);
  const order = await createNewOrder(site, externalId, payload, paymentStatus, imageCache, { isBackfilled: true });
  // Назначаем флориста только активным заказам (оплачен, не выполнен/не отменён).
  if (order.orderStatus === "CONFIRMED") {
    await assignInitial(order.id);
  }
  return { status: "created", orderId: order.id };
}
