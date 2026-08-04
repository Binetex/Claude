import "server-only";
/**
 * Ручное создание заказа владельцем.
 *
 * Отдельной «системы ручных заказов» нет и не будет: создаётся обычный Order с обычными
 * OrderItem, дальше он живёт по общим правилам — статусы, назначение флориста, Burq, SMS,
 * дополнительные расходы, финансы. Отличается ровно двумя вещами:
 *
 *  - `source = "MANUAL"` (поле свободнотекстовое, рядом с "Shopify" и "WooCommerce");
 *  - `externalId = null` — заказа нет ни на одной витрине.
 *
 * Второе и делает его неуязвимым для синхронизации: все места, где импорт помечает заказ
 * исчезнувшим, ищут строку по externalId, а массового «пометить всё, чего нет на витрине»
 * для заказов не существует вовсе. NULL не совпадёт ни с чем.
 */
import { Prisma } from "@/generated/prisma/client";
import type { FinancialItemType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { assignAndActivateFlorist } from "@/modules/assignments/service";
import { rescheduleDeliveryForOrder } from "@/integrations/delivery/burq/scheduleService";

export class ManualOrderError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "ManualOrderError";
  }
}

/** Позиция из каталога: цены и состав — снимки, каталог они не меняют. */
export type ManualCatalogItem = {
  kind: "catalog";
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Цена клиенту за штуку. */
  customerPrice: number;
  /** Цена флориста за штуку. */
  floristPrice: number;
  /** Состав/примечание — снимок ТОЛЬКО этого заказа. */
  composition: string | null;
};

/** Позиция «своим текстом»: в каталоге её нет и не будет. */
export type ManualCustomItem = {
  kind: "custom";
  name: string;
  quantity: number;
  customerPrice: number;
  floristPrice: number;
  composition: string | null;
  imageUrl: string | null;
  /**
   * Блок «Дополнительно». По умолчанию null — и это правильный дефолт: позиция без каталога
   * считается обычным цветочным товаром, расчёт дня её переживает (см. resolveItemsFinance:
   * costRequired=false → день не блокируется). Заполнять нужно только для вазы или подарка
   * со своей закупочной стоимостью.
   */
  financialType: FinancialItemType | null;
  purchaseCostCents: number | null;
};

export type ManualOrderItem = ManualCatalogItem | ManualCustomItem;

export type CreateManualOrderInput = {
  siteId: string;
  /** YYYY-MM-DD — локальный день доставки (Order.deliveryDate = UTC-полночь этого дня). */
  deliveryDate: string;
  deliveryWindow: string;
  recipientName: string;
  recipientPhone: string;
  addressLine: string;
  apartment?: string | null;
  city: string;
  zip: string;
  /** Пусто → копируется получатель: senderName/senderPhone в БД NOT NULL. */
  senderName?: string | null;
  senderPhone?: string | null;
  senderEmail?: string | null;
  recipientEmail?: string | null;
  cardMessage?: string | null;
  customerNote?: string | null;
  deliveryInstructions?: string | null;
  floristId?: string | null;
  /** Деньги заказа, в долларах. Сумма позиций считается здесь, а не приходит с формы. */
  deliveryCustomerCost?: number;
  tax?: number;
  tip?: number;
  discount?: number;
  items: ManualOrderItem[];
};

const money = (v: number) => new Prisma.Decimal(v.toFixed(2));

/** UTC-полночь локального дня: Order.deliveryDate хранится именно так (см. CLAUDE.md). */
function deliveryDateToUtcMidnight(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ManualOrderError("bad_date", "Дата доставки должна быть в формате ГГГГ-ММ-ДД.");
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ManualOrderError("bad_date", "Некорректная дата доставки.");
  return d;
}

/**
 * Номер ручного заказа: M-<КОРОТКОЕ ИМЯ>-<порядковый>.
 *
 * Order.orderNumber уникален ГЛОБАЛЬНО, поэтому номер не вычисляется заранее «по количеству»
 * — между чтением и вставкой мог появиться другой заказ. Вместо этого пробуем вставить и на
 * коллизии берём следующий: гонка разрешается базой, а не нашей арифметикой.
 */
function manualOrderNumber(shortName: string, seq: number): string {
  const base = (shortName || "M").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "M";
  return `M-${base}-${String(seq).padStart(3, "0")}`;
}

function assertItems(items: ManualOrderItem[]): void {
  if (items.length === 0) throw new ManualOrderError("no_items", "Добавьте хотя бы одну позицию.");
  for (const it of items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      throw new ManualOrderError("bad_quantity", "Количество должно быть целым числом от 1.");
    }
    if (it.customerPrice < 0 || it.floristPrice < 0) {
      throw new ManualOrderError("bad_price", "Цены не могут быть отрицательными.");
    }
    if (it.kind === "custom" && !it.name.trim()) {
      throw new ManualOrderError("no_name", "У своей позиции должно быть название.");
    }
  }
}

/**
 * Создаёт ручной заказ и возвращает его id.
 *
 * Заказ создаётся сразу оплаченным и в работе: владелец вносит его тогда, когда деньги уже
 * получены, а букет пора делать. Назначение флориста и планирование Burq идут ПОСЛЕ
 * транзакции — это их собственные пути со своими уведомлениями, и заворачивать их внутрь
 * значило бы держать транзакцию открытой на время внешних вызовов.
 */
export async function createManualOrder(input: CreateManualOrderInput): Promise<{ orderId: string; orderNumber: string }> {
  assertItems(input.items);

  const site = await prisma.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, shortName: true, platform: true },
  });
  if (!site) throw new ManualOrderError("no_site", "Магазин не найден.");

  const deliveryDate = deliveryDateToUtcMidnight(input.deliveryDate);

  // Снимки каталога берём ОДНИМ запросом: форма прислала id, но название, фото и SKU обязаны
  // попасть в заказ такими, какими они были в момент создания.
  const productIds = input.items.flatMap((i) => (i.kind === "catalog" ? [i.productId] : []));
  const variantIds = input.items.flatMap((i) => (i.kind === "catalog" && i.variantId ? [i.variantId] : []));
  const [products, variants] = await Promise.all([
    productIds.length
      ? prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, image: true, externalId: true },
        })
      : [],
    variantIds.length
      ? prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, productId: true, title: true, sku: true, image: true, externalId: true, floristComposition: true },
        })
      : [],
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const itemsData = input.items.map((it) => {
    if (it.kind === "custom") {
      return {
        productId: null,
        variantId: null,
        name: it.name.trim(),
        variantName: null,
        image: it.imageUrl,
        parentImageUrl: it.imageUrl,
        variantImageUrl: null,
        floristCompositionSnapshot: it.composition?.trim() || null,
        quantity: it.quantity,
        externalPrice: money(it.customerPrice),
        floristItemPrice: money(it.floristPrice),
        financialTypeSnapshot: it.financialType,
        purchaseCostSnapshotCents: it.purchaseCostCents,
      };
    }
    const product = productById.get(it.productId);
    if (!product) throw new ManualOrderError("no_product", "Товар из каталога не найден — обновите страницу.");
    const variant = it.variantId ? variantById.get(it.variantId) : undefined;
    return {
      // Ссылки на каталог сохраняются: по ним считается финансовый тип и закупка вазы.
      productId: product.id,
      variantId: variant?.id ?? null,
      productExternalId: product.externalId,
      variantExternalId: variant?.externalId ?? null,
      name: product.name,
      variantName: variant?.title ?? null,
      sku: variant?.sku ?? null,
      image: variant?.image ?? product.image,
      parentImageUrl: product.image,
      variantImageUrl: variant?.image ?? null,
      // Состав — снимок ЭТОГО заказа: правка здесь каталог не трогает.
      floristCompositionSnapshot: it.composition?.trim() || variant?.floristComposition || null,
      quantity: it.quantity,
      externalPrice: money(it.customerPrice),
      floristItemPrice: money(it.floristPrice),
      financialTypeSnapshot: null,
      purchaseCostSnapshotCents: null,
    };
  });

  const itemsTotal = input.items.reduce((a, i) => a + i.customerPrice * i.quantity, 0);
  const tax = input.tax ?? 0;
  const tip = input.tip ?? 0;
  const discount = input.discount ?? 0;
  const deliveryCustomerCost = input.deliveryCustomerCost ?? 0;
  const customerTotal = itemsTotal + tax + tip + deliveryCustomerCost - discount;

  const senderName = (input.senderName ?? "").trim() || input.recipientName.trim();
  const senderPhone = (input.senderPhone ?? "").trim() || input.recipientPhone.trim();

  const base = {
    siteId: site.id,
    source: "MANUAL",
    platform: site.platform,
    externalId: null,
    externalCreatedAt: new Date(),
    deliveryDate,
    deliveryWindow: input.deliveryWindow.trim(),
    recipientName: input.recipientName.trim(),
    recipientPhone: input.recipientPhone.trim(),
    recipientEmail: input.recipientEmail?.trim() || null,
    addressLine: input.addressLine.trim(),
    apartment: input.apartment?.trim() || null,
    city: input.city.trim(),
    zip: input.zip.trim(),
    senderName,
    senderPhone,
    senderEmail: input.senderEmail?.trim() || null,
    cardMessage: input.cardMessage?.trim() ?? "",
    originalCardMessage: input.cardMessage?.trim() ?? "",
    customerNote: input.customerNote?.trim() ?? "",
    originalCustomerNote: input.customerNote?.trim() ?? "",
    deliveryInstructions: input.deliveryInstructions?.trim() ?? "",
    itemsTotal: money(itemsTotal),
    tax: money(tax),
    tip: money(tip),
    discount: money(discount),
    deliveryCustomerCost: money(deliveryCustomerCost),
    customerTotal: money(customerTotal),
    // Владелец вносит заказ, когда деньги получены, а букет пора делать.
    paymentStatus: "PAID" as const,
    orderStatus: "CONFIRMED" as const,
    syncStatus: "LOCAL" as const,
    updatedAt: new Date(),
    items: { create: itemsData },
  };

  // Номер уникален глобально; на коллизии берём следующий. Пять попыток с запасом:
  // столько одновременных ручных заказов в одну секунду не бывает.
  const existing = await prisma.order.count({ where: { siteId: site.id, source: "MANUAL" } });
  let created: { id: string; orderNumber: string } | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const orderNumber = manualOrderNumber(site.shortName, existing + 1 + attempt);
    try {
      created = await prisma.order.create({
        data: { ...base, orderNumber },
        select: { id: true, orderNumber: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  if (!created) throw new ManualOrderError("number_taken", "Не удалось подобрать свободный номер заказа. Попробуйте ещё раз.");

  // Назначение и доставка — существующими путями, со своими уведомлениями.
  //
  // manualTotal передаётся ОБЯЗАТЕЛЬНО: без него assignAndActivateFlorist зовёт
  // applyAutoPriceSnapshot, а тот пересчитывает цены позиций по каталогу и затирает то, что
  // владелец только что ввёл руками. У позиции без каталога авто-правило вообще отдаёт
  // флористу полную цену клиента — в первом же тесте вместо 6$ получилось 30$.
  // Цены проставил человек, поэтому и режим цены — ручной.
  if (input.floristId) {
    const floristTotal = input.items.reduce((a, i) => a + i.floristPrice * i.quantity, 0);
    await assignAndActivateFlorist(created.id, input.floristId, { manualTotal: money(floristTotal) }).catch(() => {
      // Заказ уже создан и виден; назначение можно повторить из карточки.
    });
  }
  await rescheduleDeliveryForOrder(prisma, created.id).catch(() => {
    // Burq выключен или недоступен — карточка заказа покажет это сама.
  });

  return { orderId: created.id, orderNumber: created.orderNumber };
}
