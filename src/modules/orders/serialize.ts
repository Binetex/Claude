import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/money";

// Полный набор связей для карточки заказа.
export const orderInclude = {
  site: true,
  items: true,
  currentFlorist: { include: { user: { select: { name: true } } } },
  messages: { orderBy: { createdAt: "asc" } },
  assignments: {
    orderBy: { assignedAt: "asc" },
    include: { florist: { include: { user: { select: { name: true } } } } },
  },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof orderInclude;
}>;

// ── Общие (нефинансовые) поля, безопасные для всех ролей ──
function baseFields(o: OrderWithRelations) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    site: { name: o.site.name, shortName: o.site.shortName, colorTag: o.site.colorTag, platform: o.site.platform },
    source: o.source,
    externalCreatedAt: o.externalCreatedAt,
    deliveryDate: o.deliveryDate,
    deliveryWindow: o.deliveryWindow,
    recipientName: o.recipientName,
    recipientPhone: o.recipientPhone,
    recipientEmail: o.recipientEmail,
    addressLine: o.addressLine,
    apartment: o.apartment,
    city: o.city,
    zip: o.zip,
    cardMessage: o.cardMessage,
    customerNote: o.customerNote,
    deliveryInstructions: o.deliveryInstructions,
    paymentStatus: o.paymentStatus,
    orderStatus: o.orderStatus,
    // UI-флаг: оплата не прошла (WooCommerce `failed`). Без отдельного enum/миграции —
    // из уже сохранённых полей. Показываем «Ошибка оплаты» вместо «Ожидает оплаты».
    paymentFailed: o.externalStatus === "failed" || o.paymentClassification === "PAYMENT_FAILED",
    assignmentStatus: o.assignmentStatus,
    deliveryStatus: o.deliveryStatus,
    readyAt: o.readyAt,
    bouquetPhotoUrl: o.bouquetPhotoUrl,
    deliveryPhotoUrl: o.deliveryPhotoUrl,
    trackingUrl: o.trackingUrl,
    // Версия записи для оптимистической блокировки (OCC) при редактировании блоков.
    updatedAt: o.updatedAt.toISOString(),
    // Назначение флориста (currentFlorist*) НЕ в базе: колл-центр и флорист его не видят.
    // Оно добавляется только в serializeForOwner ниже.
  };
}

// ─────────────── ВЛАДЕЛЕЦ: всё, включая финансы ───────────────
export function serializeForOwner(o: OrderWithRelations) {
  return {
    ...baseFields(o),
    currentFloristName: o.currentFlorist?.user.name ?? null,
    currentFloristId: o.currentFloristId,
    senderName: o.senderName,
    senderPhone: o.senderPhone,
    senderEmail: o.senderEmail,
    senderAddress: {
      addressLine: o.senderAddressLine,
      apartment: o.senderApartment,
      city: o.senderCity,
      province: o.senderProvince,
      zip: o.senderZip,
      country: o.senderCountry,
    },
    syncStatus: o.syncStatus,
    priceMode: o.priceMode,
    items: o.items.map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      image: i.image,
      floristComposition: i.floristCompositionSnapshot,
      quantity: i.quantity,
      options: i.options,
      externalPrice: toNumber(i.externalPrice),
      floristItemPrice: toNumber(i.floristItemPrice),
    })),
    finance: {
      itemsTotal: toNumber(o.itemsTotal),
      tax: toNumber(o.tax),
      tip: toNumber(o.tip),
      discount: toNumber(o.discount),
      deliveryCustomerCost: toNumber(o.deliveryCustomerCost),
      customerTotal: toNumber(o.customerTotal),
      floristTotal: toNumber(o.floristTotal),
      deliveryActualCost: toNumber(o.deliveryActualCost),
      estimatedProfit: toNumber(o.estimatedProfit),
    },
    assignments: o.assignments.map((a) => ({
      floristName: a.florist.user.name,
      state: a.state,
      priceMode: a.priceMode,
      floristTotal: toNumber(a.floristTotalSnapshot),
      assignedAt: a.assignedAt,
      respondedAt: a.respondedAt,
    })),
    messages: o.messages.map(serializeMessage),
  };
}
export type OwnerOrder = ReturnType<typeof serializeForOwner>;

// ─────────────── КОЛЛ-ЦЕНТР: всё для общения, БЕЗ финансов ───────────────
export function serializeForCallCenter(o: OrderWithRelations) {
  return {
    ...baseFields(o),
    senderName: o.senderName,
    senderPhone: o.senderPhone,
    senderEmail: o.senderEmail,
    items: o.items.map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      image: i.image,
      floristComposition: i.floristCompositionSnapshot,
      quantity: i.quantity,
      options: i.options,
      // Никаких цен: externalPrice/floristItemPrice физически отсутствуют.
    })),
    messages: o.messages.map(serializeMessage),
  };
}
export type CallCenterOrder = ReturnType<typeof serializeForCallCenter>;

// ─────────────── ФЛОРИСТ: своя цена всегда; полная раскладка — только при FULL ───────────────
//
// financeVisibility на профиле флориста управляет видимостью:
//  - MAKER_ONLY (по умолчанию) — только floristTotal/floristItemPrice, как в исходном ТЗ.
//  - FULL       — дополнительно налог/доставка(клиенту)/чаевые/скидка/итог клиента.
// В ОБОИХ режимах флористу НИКОГДА не отдаются: прибыль владельца (estimatedProfit),
// фактическая себестоимость доставки (deliveryActualCost) и цены/заказы других флористов.
export function serializeForFlorist(o: OrderWithRelations) {
  const isFull = o.currentFlorist?.financeVisibility === "FULL";
  return {
    ...baseFields(o),
    // Данные заказчика (senderName/senderPhone) — флористу нужны, чтобы позвонить по
    // вопросам букета/доставки. senderEmail не включаем — не нужен, не запрашивался.
    senderName: o.senderName,
    senderPhone: o.senderPhone,
    items: o.items.map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      image: i.image,
      floristComposition: i.floristCompositionSnapshot,
      quantity: i.quantity,
      options: i.options,
      floristItemPrice: toNumber(i.floristItemPrice), // его цена за позицию
      // externalPrice (цена клиента) НЕ включается.
    })),
    floristTotal: toNumber(o.floristTotal), // только его сумма
    ...(isFull
      ? {
          finance: {
            itemsTotal: toNumber(o.itemsTotal),
            tax: toNumber(o.tax),
            tip: toNumber(o.tip),
            discount: toNumber(o.discount),
            deliveryCustomerCost: toNumber(o.deliveryCustomerCost),
            customerTotal: toNumber(o.customerTotal),
          },
        }
      : {}),
  };
}
export type FloristOrder = ReturnType<typeof serializeForFlorist>;

function serializeMessage(m: OrderWithRelations["messages"][number]) {
  return {
    id: m.id,
    channel: m.channel,
    direction: m.direction,
    party: m.party,
    body: m.body,
    createdAt: m.createdAt,
  };
}
