import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/money";
import { computeEstimatedProfit } from "@/modules/pricing/profit";
import { compensableItems, effectiveFloristTotal, isTipItem } from "@/modules/pricing/serviceItems";
import { getOrderItemImages } from "./images";

/**
 * Цена флориста по позиции и сумма к оплате — с исключёнными чаевыми. Считается на лету,
 * поэтому исторические заказы, где чаевые попали в снимок, показываются правильно без
 * правки данных. У новых заказов поправка нулевая.
 */
function floristMoney(o: OrderListRow) {
  const items = o.items.map((i) => ({
    name: i.name,
    productId: i.productId,
    variantId: i.variantId,
    floristItemPrice: toNumber(i.floristItemPrice),
  }));
  return {
    total: effectiveFloristTotal(toNumber(o.floristTotal), items),
    itemPrice: (i: OrderListRow["items"][number]) => (isTipItem(i) ? 0 : toNumber(i.floristItemPrice)),
    /**
     * Цена флориста НЕ ЗАДАНА в каталоге. Ноль сам по себе валиден («делаем бесплатно»),
     * но у оплаченной позиции он почти всегда означает незаполненный прайс — и молчаливый
     * «$0.00» это скрывает. Раньше на его месте стояла цена КЛИЕНТА, что было хуже: число
     * выглядело настоящим (см. фолбэк в modules/pricing/service.ts).
     *
     * Служебные позиции (чаевые) обнуляются намеренно и признаком не считаются.
     */
    priceMissing: (i: OrderListRow["items"][number]) =>
      !isTipItem(i) && toNumber(i.floristItemPrice) === 0 && toNumber(i.externalPrice) > 0,
  };
}

/** "int_uspdw9pdbhk4383b0pz" → "int_…83b0pz" — достаточно для сверки, без длинного хвоста. */
function shortIntent(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 4)}…${id.slice(-6)}`;
}

/**
 * ЛЁГКИЙ набор связей для СПИСКОВ: ровно то, что рендерят таблицы трёх ролей.
 *
 * Ни messages, ни assignments, ни airwallexPayment здесь нет намеренно: раньше include был
 * один на карточку и списки, и страница на пятьдесят заказов загружала и сериализовала полную
 * SMS-историю каждого — сотни сообщений, которых список не показывает. Это была самая дорогая
 * лишняя работа в проекте.
 */
export const orderListInclude = {
  site: true,
  items: true,
  currentFlorist: {
    select: { id: true, avatarUrl: true, financeVisibility: true, user: { select: { name: true } } },
  },
} satisfies Prisma.OrderInclude;

export type OrderListRow = Prisma.OrderGetPayload<{ include: typeof orderListInclude }>;

// Полный набор связей для карточки заказа.
export const orderInclude = {
  // Состояние сверки с Airwallex — отдаётся ТОЛЬКО владельцу (см. serializeForOwner).
  airwallexPayment: true,
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
function baseFields(o: OrderListRow) {
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
  const florist = floristMoney(o);
  return {
    ...baseFields(o),
    currentFloristName: o.currentFlorist?.user.name ?? null,
    currentFloristAvatarUrl: o.currentFlorist?.avatarUrl ?? null,
    currentFloristId: o.currentFloristId,
    // Пометка о работе с клиентом — решение владельца, ему и правится.
    marketingMark: o.marketingMark,
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
    airwallex: o.airwallexPayment
      ? {
          paymentMethod: o.airwallexPayment.paymentMethod,
          // Intent показываем сокращённо — полный id владельцу не нужен в списке.
          intentIdShort: o.airwallexPayment.paymentIntentId ? shortIntent(o.airwallexPayment.paymentIntentId) : null,
          rawStatus: o.airwallexPayment.lastRawStatus,
          normalizedStatus: o.airwallexPayment.normalizedStatus,
          attemptStatus: o.airwallexPayment.lastAttemptStatus,
          lastCheckedAt: o.airwallexPayment.lastCheckedAt,
          nextCheckAt: o.airwallexPayment.nextCheckAt,
          pendingSinceMinutes: o.airwallexPayment.firstPendingAt
            ? Math.max(0, Math.round((Date.now() - o.airwallexPayment.firstPendingAt.getTime()) / 60000))
            : null,
          monitoringActive: o.airwallexPayment.monitoringActive,
          safeError: o.airwallexPayment.safeError,
        }
      : null,
    // Служебная строка «Tip» из Shopify в список не идёт: это не товар, а способ прислать
    // чаевые. Деньги не теряются — сумма чаевых живёт в Order.tip. Состав позиции общий со
    // строкой списка (ownerItems ниже).
    items: ownerItems(o),
    finance: {
      itemsTotal: toNumber(o.itemsTotal),
      tax: toNumber(o.tax),
      tip: toNumber(o.tip),
      discount: toNumber(o.discount),
      deliveryCustomerCost: toNumber(o.deliveryCustomerCost),
      customerTotal: toNumber(o.customerTotal),
      floristTotal: florist.total,
      deliveryActualCost: toNumber(o.deliveryActualCost),
      // Считаем ЗДЕСЬ, а не берём сохранённое Order.estimatedProfit: поле обновляется только
      // при назначении флориста, поэтому устаревало при любом изменении сумм (чаевые, факт
      // доставки, обновление из Woo) — у двух третей заказов оно было нулевым.
      estimatedProfit: computeEstimatedProfit({
        itemsTotal: toNumber(o.itemsTotal),
        tax: toNumber(o.tax),
        tip: toNumber(o.tip),
        deliveryCustomerCost: toNumber(o.deliveryCustomerCost),
        floristTotal: florist.total,
        deliveryActualCost: toNumber(o.deliveryActualCost),
      }),
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

/** Позиции с ценами владельца — общий кусок карточки и строки списка. */
function ownerItems(o: OrderListRow) {
  const florist = floristMoney(o);
  return compensableItems(o.items).map((i) => ({
    id: i.id,
    name: i.name,
    variantName: i.variantName,
    productId: i.productId,
    image: getOrderItemImages(i).primary,
    variantImage: getOrderItemImages(i).variant,
    floristComposition: i.floristCompositionSnapshot,
    quantity: i.quantity,
    options: i.options,
    externalPrice: toNumber(i.externalPrice),
    floristItemPrice: florist.itemPrice(i),
    floristPriceMissing: florist.priceMissing(i),
  }));
}

// ─────────────── СТРОКИ СПИСКОВ: без переписки, назначений и Airwallex ───────────────
//
// Отдельные сериализаторы, а не «полный минус лишнее»: состав строки списка определяется тем,
// что таблица реально показывает, и TypeScript отлавливает попытку прочитать поле, которого
// в строке больше нет.

export function serializeOwnerListRow(o: OrderListRow) {
  const florist = floristMoney(o);
  return {
    ...baseFields(o),
    currentFloristName: o.currentFlorist?.user.name ?? null,
    currentFloristAvatarUrl: o.currentFlorist?.avatarUrl ?? null,
    items: ownerItems(o),
    finance: {
      customerTotal: toNumber(o.customerTotal),
      floristTotal: florist.total,
    },
  };
}
export type OwnerListRowVM = ReturnType<typeof serializeOwnerListRow>;

export function serializeCallCenterListRow(o: OrderListRow) {
  return {
    ...baseFields(o),
    currentFloristName: o.currentFlorist?.user.name ?? null,
    currentFloristAvatarUrl: o.currentFlorist?.avatarUrl ?? null,
    // Без цен: правило то же, что у полной карточки колл-центра.
    items: compensableItems(o.items).map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      image: getOrderItemImages(i).primary,
      quantity: i.quantity,
    })),
  };
}

export function serializeFloristListRow(o: OrderListRow) {
  const isFull = o.currentFlorist?.financeVisibility === "FULL";
  const florist = floristMoney(o);
  return {
    ...baseFields(o),
    items: compensableItems(o.items).map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      image: getOrderItemImages(i).primary,
      quantity: i.quantity,
    })),
    floristTotal: florist.total,
    financeVisibility: isFull ? ("FULL" as const) : ("MAKER_ONLY" as const),
    // Раскладка не нужна: страница берёт из неё одну сумму заказчика — её и отдаём.
    ...(isFull ? { finance: { customerTotal: toNumber(o.customerTotal) } } : {}),
  };
}

// ─────────────── КОЛЛ-ЦЕНТР: всё для общения, БЕЗ финансов ───────────────
export function serializeForCallCenter(o: OrderWithRelations) {
  return {
    ...baseFields(o),
    // Пометка владельца — оператор её ВИДИТ и выполняет, но не ставит (ставит владелец).
    marketingMark: o.marketingMark,
    // Колл-центр ВИДИТ, какому флористу назначен заказ (имя + аватарка, для справки).
    // Переназначение и цены флориста остаются недоступны (нет currentFloristId/finance).
    currentFloristName: o.currentFlorist?.user.name ?? null,
    currentFloristAvatarUrl: o.currentFlorist?.avatarUrl ?? null,
    senderName: o.senderName,
    senderPhone: o.senderPhone,
    senderEmail: o.senderEmail,
    // Служебная строка «Tip» скрыта — см. пояснение у serializeForOwner.
    items: compensableItems(o.items).map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      // image — основное фото (parent ?? legacy); variantImage — доп. фото вариации,
      // уже отфильтрованное от дублей. Общие списки читают только image.
      image: getOrderItemImages(i).primary,
      variantImage: getOrderItemImages(i).variant,
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
//  - FULL       — дополнительно налог/доставка(клиенту)/чаевые/скидка/итог клиента И цена
//                 клиента по каждой позиции: основной флорист работает с полной суммой
//                 заказа, и «его цена» в списке товаров ему ничего не говорит.
// В ОБОИХ режимах флористу НИКОГДА не отдаются: прибыль владельца (estimatedProfit),
// фактическая себестоимость доставки (deliveryActualCost) и цены/заказы других флористов.
export function serializeForFlorist(o: OrderWithRelations) {
  const isFull = o.currentFlorist?.financeVisibility === "FULL";
  const florist = floristMoney(o);
  return {
    ...baseFields(o),
    // Данные заказчика (senderName/senderPhone) — флористу нужны, чтобы позвонить по
    // вопросам букета/доставки. senderEmail не включаем — не нужен, не запрашивался.
    senderName: o.senderName,
    senderPhone: o.senderPhone,
    // Служебная строка «Tip» скрыта — см. пояснение у serializeForOwner.
    items: compensableItems(o.items).map((i) => ({
      id: i.id,
      name: i.name,
      variantName: i.variantName,
      // image — основное фото (parent ?? legacy); variantImage — доп. фото вариации,
      // уже отфильтрованное от дублей. Общие списки читают только image.
      image: getOrderItemImages(i).primary,
      variantImage: getOrderItemImages(i).variant,
      floristComposition: i.floristCompositionSnapshot,
      quantity: i.quantity,
      options: i.options,
      floristItemPrice: florist.itemPrice(i), // его цена за позицию (чаевые — ноль)
      floristPriceMissing: florist.priceMissing(i),
      // Цена клиента — ТОЛЬКО при FULL. У MAKER_ONLY её нет по определению режима, и
      // null здесь означает «не положено видеть», а не «ноль».
      externalPrice: isFull ? toNumber(i.externalPrice) : null,
    })),
    floristTotal: florist.total, // только его сумма, без чаевых владельца
    // Read-only признак режима видимости — чтобы интерфейс не угадывал его по наличию
    // блока finance. Прав не добавляет: что показывать, решает состав полей ниже.
    financeVisibility: isFull ? ("FULL" as const) : ("MAKER_ONLY" as const),
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
