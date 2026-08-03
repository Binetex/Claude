"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { requireRole } from "@/lib/rbac";
import { ownerSetCardMessage } from "@/modules/print/cardEdit";
import { CARD_MESSAGE_MAX } from "@/lib/print/cardText";
import { hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OrderStatus, FloristFinanceVisibility, Role, FinancialItemType, VaseCostType } from "@/generated/prisma/enums";
import { setProductClassification, setVariantClassification } from "@/modules/catalog/finance/classification";
import { setVasePurchaseCost, deleteVasePurchaseCost } from "@/modules/catalog/finance/setVasePurchaseCost";
import { setVariantVase, setProductDefaultVase, type VaseSelection } from "@/modules/catalog/finance/vaseLink";
import { usdToCents } from "@/lib/cents";
import {
  reassignManual,
  setManualFloristPrice,
  addSitePriority,
  removeSitePriority,
  moveSitePriority,
  assignPendingOrdersForSite,
} from "@/modules/assignments/service";
import {
  normalizeShopDomain,
  isValidShopDomain,
  createOAuthState,
  buildAuthorizeUrl,
} from "@/integrations/shopify/oauth";
import { syncOrderToShopify } from "@/integrations/shopify/pushUpdate";
import { startProductSyncInBackground } from "@/modules/catalog/sync";
import { startOrderSyncInBackground } from "@/modules/orders/sync";
import { getAppUrl } from "@/lib/appUrl";
import { TERMINAL_ORDER_STATUSES } from "@/lib/statuses";
import { normalizePhone } from "@/lib/phone";
import { onOrderDeliveryChangeSafe } from "@/integrations/delivery/burq/scheduleService";
import { scheduleDeliveryTodayTrigger } from "@/modules/automations/lifecycle";

async function ownerOnly() {
  await requireRole("OWNER");
}

/**
 * Владелец меняет ТЕКСТ ОТКРЫТКИ (cardMessage) для печати. В отличие от ownerUpdateCardAndNote,
 * НЕ пушит в Shopify/Woo и меняет только cardMessage — используется во вкладке печати открыток.
 */
export async function ownerUpdateCardMessage(orderId: string, cardMessage: string): Promise<{ ok?: boolean; error?: string; message?: string }> {
  await requireRole("OWNER");
  if (typeof cardMessage !== "string") return { error: "Некорректный текст." };
  if (cardMessage.length > CARD_MESSAGE_MAX + 1000) return { error: `Текст слишком длинный (максимум ${CARD_MESSAGE_MAX}).` };
  const { ok } = await ownerSetCardMessage(orderId, cardMessage);
  if (!ok) return { error: "Заказ не найден." };
  revalidatePath("/dashboard/print-cards");
  return { ok: true, message: "Текст открытки сохранён." };
}

export async function ownerSetOrderStatus(orderId: string, status: OrderStatus) {
  await ownerOnly();
  const before = await prisma.order.findUnique({ where: { id: orderId }, select: { orderStatus: true } });
  await prisma.order.update({ where: { id: orderId }, data: { orderStatus: status } });
  // Финансы: ручная отметка «доставлен» — такой же повод начислить, как курьер и платформа.
  // Публикуем только на ПЕРЕХОДЕ: повторное сохранение того же статуса ничего не запускает.
  if (status === "DELIVERED" && before?.orderStatus !== "DELIVERED") {
  }
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
  revalidatePath("/dashboard");
}

export async function ownerUpdateDelivery(
  orderId: string,
  data: { deliveryDate?: string; deliveryWindow?: string }
) {
  await ownerOnly();
  await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(data.deliveryDate ? { deliveryDate: new Date(data.deliveryDate) } : {}),
      ...(data.deliveryWindow ? { deliveryWindow: data.deliveryWindow } : {}),
    },
  });
  // Дата/окно доставки влияют на availableAt и dropoff_at → пере-планировать/пере-создать draft.
  await onOrderDeliveryChangeSafe(prisma, orderId);
  // Дата сменилась → триггер «Доставка сегодня» должен встать на новый день.
  await scheduleDeliveryTodayTrigger(prisma, orderId);
  revalidatePath(`/dashboard/orders/${orderId}`);
}

export async function ownerUpdateContacts(
  orderId: string,
  data: {
    recipientName?: string;
    recipientPhone?: string;
    recipientEmail?: string;
    addressLine?: string;
    apartment?: string;
    city?: string;
    zip?: string;
  }
) {
  await ownerOnly();
  await prisma.order.update({
    where: { id: orderId },
    data: { ...data, ...(data.recipientPhone !== undefined ? { recipientPhone: normalizePhone(data.recipientPhone) } : {}) },
  });
  await syncOrderToShopify(orderId);
  // Адрес/телефон получателя = dropoff → пере-создать неинициированный draft со свежими данными.
  await onOrderDeliveryChangeSafe(prisma, orderId);
  revalidatePath(`/dashboard/orders/${orderId}`);
}

/** Контакты отправителя заказа (правятся вручную из карточки заказа). */
export async function ownerUpdateSender(
  orderId: string,
  data: { senderName?: string; senderPhone?: string; senderEmail?: string }
) {
  await ownerOnly();
  await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(data.senderName !== undefined ? { senderName: data.senderName } : {}),
      ...(data.senderPhone !== undefined ? { senderPhone: normalizePhone(data.senderPhone) } : {}),
      ...(data.senderEmail !== undefined ? { senderEmail: data.senderEmail || null } : {}),
    },
  });
  revalidatePath(`/dashboard/orders/${orderId}`);
}

/**
 * Открытка и заметка меняются ТОЛЬКО по явному действию пользователя.
 * Оригиналы (originalCardMessage/originalCustomerNote) не трогаем.
 *
 * cardMessage дополнительно уходит обратно в Shopify (стандартное поле заказа "note") —
 * у этого магазина открытку клиенты пишут именно туда, см.
 * extractAddressAndCardMessage в ingestOrder.ts. customerNote остаётся только внутри
 * Floremart — ручное поле владельца/колл-центра, Shopify им не управляет.
 */
export async function ownerUpdateCardAndNote(
  orderId: string,
  data: { cardMessage?: string; customerNote?: string }
) {
  await ownerOnly();
  await prisma.order.update({ where: { id: orderId }, data });
  await syncOrderToShopify(orderId);
  revalidatePath(`/dashboard/orders/${orderId}`);
}

export async function ownerSetManualPrice(orderId: string, amount: number) {
  const user = await requireRole("OWNER");
  await setManualFloristPrice(orderId, amount);
  // Если по заказу уже есть начисление — оно сторнируется и создаётся новое.
  // Опубликованную запись не правим никогда: история должна объяснять любую сумму.
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/finance/florists");
}

export async function ownerReassign(
  orderId: string,
  floristId: string,
  keepManualPrice: boolean
) {
  const user = await requireRole("OWNER");
  await reassignManual(orderId, floristId, keepManualPrice);
  // Переназначение УЖЕ доставленного заказа переносит деньги: начисление прежнего
  // флориста сторнируется, новому создаётся своё.
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/finance/florists");
}

/**
 * Ограниченная (авто) цена изготовления товара для конкретного флориста.
 * Не трогает уже размещённые заказы — там цена зафиксирована снимком.
 */
export async function ownerSetProductFloristPrice(productId: string, amount: number | null) {
  await ownerOnly();
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) return;
  // null → цена не задана: флорист получит полную стоимость заказа.
  await prisma.product.update({
    where: { id: productId },
    data: { floristPrice: amount != null ? new Prisma.Decimal(amount) : null },
  });
  revalidatePath("/dashboard/products");
  revalidatePath(`/dashboard/products/${productId}`);
}

/** Цена флориста для конкретного варианта. null — очистить (тогда действует цена товара). */
export async function ownerSetVariantFloristPrice(variantId: string, amount: number | null) {
  await ownerOnly();
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) return;
  const variant = await prisma.productVariant.update({
    where: { id: variantId },
    data: { floristPrice: amount != null ? new Prisma.Decimal(amount) : null },
    select: { productId: true },
  });
  revalidatePath("/dashboard/products");
  revalidatePath(`/dashboard/products/${variant.productId}`);
}

/** Локальный состав букета для конкретного варианта. Shopify sync его не трогает. */
export async function ownerSetVariantComposition(variantId: string, text: string | null) {
  await ownerOnly();
  const trimmed = text?.trim() || null;
  const v = await prisma.productVariant.update({
    where: { id: variantId },
    data: { floristComposition: trimmed },
    select: { productId: true },
  });
  revalidatePath(`/dashboard/products/${v.productId}`);
  revalidatePath("/dashboard/products");
}

// ─────────── Финансовая классификация каталога и закупочная стоимость ваз ───────────
// Все действия ниже — тонкие обёртки над сервисом modules/catalog/finance: тот же путь
// записи, та же валидация и тот же аудит будут у экрана bulk-review. Второй формулы нет.

/** Тип позиции и дефолт «содержит вазу» на уровне ТОВАРА. null = очистить значение. */
export async function ownerSetProductFinance(
  productId: string,
  patch: { financialType?: FinancialItemType | null; defaultIncludesVase?: boolean | null }
) {
  const user = await requireRole("OWNER");
  await setProductClassification({ productId, patch, actor: { userId: user.id, role: user.role } });
  revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/dashboard/products");
}

/** Тип позиции и признак вазы на уровне ВАРИАНТА. null = вернуть наследование от товара. */
export async function ownerSetVariantFinance(
  variantId: string,
  patch: { financialType?: FinancialItemType | null; includesVase?: boolean | null }
) {
  const user = await requireRole("OWNER");
  await setVariantClassification({ variantId, patch, actor: { userId: user.id, role: user.role } });
  const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
  if (v) revalidatePath(`/dashboard/products/${v.productId}`);
  revalidatePath("/dashboard/products");
}

/**
 * Новый интервал закупочной стоимости вазы. Прямого update таблицы нет: запись идёт только
 * через setVasePurchaseCost, который закрывает предыдущий интервал и пишет аудит.
 * Дата начала действия обязательна; дата в будущем допустима.
 */
export async function ownerAddVaseCost(args: {
  target: { productId: string } | { productVariantId: string };
  costType: VaseCostType;
  amountUsd: string;
  comment?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireRole("OWNER");

  let cents: number | null;
  try {
    cents = usdToCents(args.amountUsd);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "некорректная сумма" };
  }
  if (cents == null) return { ok: false, error: "укажите закупочную стоимость" };

  // Снимки названий для аудита: отчёт должен читаться и после исчезновения товара с платформы.
  const named =
    "productId" in args.target
      ? await prisma.product.findUnique({
          where: { id: args.target.productId },
          select: { name: true, site: { select: { shortName: true } } },
        })
      : await prisma.productVariant
          .findUnique({
            where: { id: args.target.productVariantId },
            select: { title: true, product: { select: { name: true, site: { select: { shortName: true } } } } },
          })
          .then((v) => (v ? { name: `${v.product.name} / ${v.title}`, site: v.product.site } : null));

  try {
    await setVasePurchaseCost({
      target: args.target,
      costType: args.costType,
      purchaseCostCents: cents,
      actor: { userId: user.id, role: user.role },
      comment: args.comment?.trim() || undefined,
      entityNameSnapshot: named?.name,
      siteShortNameSnapshot: named?.site.shortName,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "не удалось сохранить стоимость" };
  }

  const productId =
    "productId" in args.target
      ? args.target.productId
      : (await prisma.productVariant.findUnique({ where: { id: args.target.productVariantId }, select: { productId: true } }))
          ?.productId;
  if (productId) revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/dashboard/products");
  return { ok: true };
}

/** Удаление ошибочно заведённой стоимости. После него она считается неизвестной. */
export async function ownerDeleteVaseCost(args: {
  costId: string;
  productId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireRole("OWNER");
  try {
    await deleteVasePurchaseCost({ costId: args.costId, actor: { userId: user.id, role: user.role } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "не удалось удалить" };
  }
  revalidatePath(`/dashboard/products/${args.productId}`);
  revalidatePath("/dashboard/products");
  return { ok: true };
}

/**
 * Ваза внутри букета — ССЫЛКА на вариант товара-вазы. Закупочная стоимость у букета не
 * хранится: она берётся у самой вазы. Валидация (тот же магазин, эффективный тип VASE,
 * не архив, не сама позиция) — в сервисе, здесь только прокси и понятная ошибка в UI.
 */
export async function ownerSetVariantVase(
  variantId: string,
  selection: VaseSelection
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireRole("OWNER");
  try {
    await setVariantVase({ variantId, selection, actor: { userId: user.id, role: user.role } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "не удалось сохранить" };
  }
  const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
  if (v) revalidatePath(`/dashboard/products/${v.productId}`);
  revalidatePath("/dashboard/products");
  return { ok: true };
}

/** Ваза по умолчанию на уровне товара. Варианты наследуют её, пока не переопределят. */
export async function ownerSetProductDefaultVase(
  productId: string,
  selection: VaseSelection
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireRole("OWNER");
  try {
    await setProductDefaultVase({ productId, selection, actor: { userId: user.id, role: user.role } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "не удалось сохранить" };
  }
  revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/dashboard/products");
  return { ok: true };
}

/** Шаблон состава товара (defaultFloristComposition) — только для заполнения вариантов, не для заказа. */
export async function ownerSetProductDefaultComposition(productId: string, text: string | null) {
  await ownerOnly();
  const trimmed = text?.trim() || null;
  await prisma.product.update({ where: { id: productId }, data: { defaultFloristComposition: trimmed } });
  revalidatePath(`/dashboard/products/${productId}`);
}

/** Обновляет snapshot состава КОНКРЕТНОЙ позиции заказа из текущего состава её варианта. */
export async function ownerUpdateOrderItemComposition(itemId: string) {
  await ownerOnly();
  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    select: { variantId: true, orderId: true },
  });
  if (!item?.variantId) return;
  const variant = await prisma.productVariant.findUnique({
    where: { id: item.variantId },
    select: { floristComposition: true },
  });
  await prisma.orderItem.update({
    where: { id: itemId },
    data: { floristCompositionSnapshot: variant?.floristComposition ?? null },
  });
  revalidatePath(`/dashboard/orders/${item.orderId}`);
}

/**
 * Массово заполняет ПУСТЫЕ snapshot'ы составов у позиций АКТИВНЫХ заказов из текущего состава
 * варианта. Не перезаписывает уже заполненные snapshot. Терминальные заказы не трогает.
 */
export async function ownerBulkFillActiveOrderCompositions(): Promise<{ updated: number }> {
  await ownerOnly();
  const items = await prisma.orderItem.findMany({
    where: {
      floristCompositionSnapshot: null,
      variantId: { not: null },
      order: { orderStatus: { notIn: TERMINAL_ORDER_STATUSES } },
    },
    select: { id: true, variantId: true },
  });
  const variantIds = [...new Set(items.map((i) => i.variantId).filter((x): x is string => !!x))];
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, floristComposition: true } })
    : [];
  const byId = new Map(variants.map((v) => [v.id, v.floristComposition]));
  let updated = 0;
  for (const it of items) {
    const comp = it.variantId ? byId.get(it.variantId) : null;
    if (comp && comp.trim()) {
      await prisma.orderItem.update({ where: { id: it.id }, data: { floristCompositionSnapshot: comp } });
      updated++;
    }
  }
  revalidatePath("/dashboard/orders");
  return { updated };
}

/** Запускает фоновую синхронизацию товаров сайта. Не блокирует UI — прогресс в SiteSync. */
export async function ownerSyncProducts(siteId: string) {
  await ownerOnly();
  startProductSyncInBackground(siteId);
  revalidatePath("/dashboard/sites");
  revalidatePath("/dashboard/products");
}

/** Запускает фоновую синхронизацию заказов сайта (окно по умолчанию). Прогресс в SiteSync. */
export async function ownerSyncOrders(siteId: string) {
  await ownerOnly();
  startOrderSyncInBackground(siteId);
  revalidatePath("/dashboard/sites");
}

/** Запускает синхронизацию товаров по ВСЕМ подключённым сайтам (кнопка на /dashboard/products). */
export async function ownerSyncAllProducts() {
  await ownerOnly();
  const sites = await prisma.site.findMany({ where: { connectionStatus: "CONNECTED" }, select: { id: true } });
  for (const s of sites) startProductSyncInBackground(s.id);
  revalidatePath("/dashboard/products");
}

/** Агрегированный прогресс синхронизации товаров по всем сайтам (для кнопки на /dashboard/products). */
export async function ownerGetProductsSyncSummary() {
  await ownerOnly();
  const rows = await prisma.siteSync.findMany({ where: { kind: "PRODUCTS" } });
  if (!rows.length) return null;
  const anyRunning = rows.some((r) => r.status === "RUNNING");
  const anyError = rows.some((r) => r.status === "ERROR");
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totals = rows.map((r) => r.total).filter((t): t is number => t != null);
  return {
    status: anyRunning ? "RUNNING" : anyError ? "ERROR" : "DONE",
    total: totals.length === rows.length ? sum((r) => r.total ?? 0) : null,
    processed: sum((r) => r.processed),
    created: sum((r) => r.created),
    updated: sum((r) => r.updated),
    skipped: sum((r) => r.skipped),
    errors: sum((r) => r.errors),
  } as const;
}
export type ProductsSyncSummary = Awaited<ReturnType<typeof ownerGetProductsSyncSummary>>;

/** Текущий прогресс синхронизаций сайта для поллинга из UI. */
export async function ownerGetSyncStatus(siteId: string) {
  await ownerOnly();
  const rows = await prisma.siteSync.findMany({ where: { siteId } });
  const pick = (kind: "PRODUCTS" | "ORDERS") => {
    const r = rows.find((x) => x.kind === kind);
    if (!r) return null;
    return {
      status: r.status,
      total: r.total,
      processed: r.processed,
      created: r.created,
      updated: r.updated,
      skipped: r.skipped,
      errors: r.errors,
      errorMessage: r.errorMessage,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    };
  };
  return { products: pick("PRODUCTS"), orders: pick("ORDERS") };
}
export type SyncStatusSnapshot = Awaited<ReturnType<typeof ownerGetSyncStatus>>;

/**
 * Режим видимости финансов для флориста: MAKER_ONLY (только его цена)
 * или FULL (плюс налог/доставка клиенту/чаевые/итог клиента). Прибыль владельца
 * и чужие цены флористу не видны в любом режиме — см. serializeForFlorist.
 */
export async function ownerSetFloristFinanceVisibility(
  floristId: string,
  visibility: FloristFinanceVisibility
) {
  await ownerOnly();
  await prisma.florist.update({ where: { id: floristId }, data: { financeVisibility: visibility } });
  revalidatePath("/dashboard/florists");
}

/** Название сайта — единственное, что владелец может переименовать вручную (см. /dashboard/sites). */
export async function ownerUpdateSiteName(siteId: string, name: string) {
  await ownerOnly();
  const trimmed = name.trim();
  if (!trimmed) return;
  await prisma.site.update({ where: { id: siteId }, data: { name: trimmed } });
  revalidatePath("/dashboard/sites");
  revalidatePath("/dashboard/orders");
  revalidatePath("/dashboard");
}

export async function ownerAddSitePriority(siteId: string, floristId: string) {
  await ownerOnly();
  await addSitePriority(siteId, floristId);
  revalidatePath("/dashboard/florists");
}

export async function ownerRemoveSitePriority(siteId: string, floristId: string) {
  await ownerOnly();
  await removeSitePriority(siteId, floristId);
  revalidatePath("/dashboard/florists");
}

export async function ownerMoveSitePriority(siteId: string, floristId: string, direction: "up" | "down") {
  await ownerOnly();
  await moveSitePriority(siteId, floristId, direction);
  revalidatePath("/dashboard/florists");
}

/** Назначает основного флориста всем оплаченным неназначенным заказам сайта задним числом. */
export async function ownerAssignPendingForSite(siteId: string): Promise<{ assigned: number }> {
  await ownerOnly();
  const result = await assignPendingOrdersForSite(siteId);
  revalidatePath("/dashboard/florists");
  revalidatePath("/dashboard/orders");
  return result;
}

/**
 * Старт подключения магазина Shopify: owner вводит домен, мы редиректим
 * на страницу согласия Shopify. Сам access token появится позже — его
 * запишет callback-эндпоинт после того, как владелец магазина подтвердит установку.
 */
export async function ownerConnectShopify(_prev: unknown, formData: FormData) {
  await ownerOnly();
  const raw = String(formData.get("shopDomain") ?? "");
  const shopDomain = normalizeShopDomain(raw);
  if (!isValidShopDomain(shopDomain)) {
    return { error: "Введите корректный домен магазина, например my-shop.myshopify.com" };
  }

  const redirectUri = `${getAppUrl()}/api/integrations/shopify/oauth/callback`;
  const state = createOAuthState(shopDomain);
  redirect(buildAuthorizeUrl(shopDomain, redirectUri, state));
}

export type CreateUserRoleChoice = "FLORIST_PRIMARY" | "FLORIST_SECONDARY" | "CALL_CENTER";

/**
 * Создаёт нового сотрудника. Пароль генерируется случайно и возвращается ОДИН РАЗ
 * в ответе — владелец должен сразу скопировать его и передать сотруднику; нигде
 * больше (ни в БД, ни в логах) он не хранится в открытом виде.
 *
 * Роль "основной флорист" / "второстепенный флорист" — это одна и та же роль FLORIST,
 * разница только в financeVisibility (см. Florist.financeVisibility): основной видит
 * полную раскладку (налог/доставка/чаевые), второстепенный — только назначенную цену.
 */
export async function ownerCreateUser(
  _prev: unknown,
  formData: FormData
): Promise<{ error?: string; success?: true; email?: string; password?: string }> {
  await ownerOnly();

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  const roleChoice = String(formData.get("roleChoice") ?? "") as CreateUserRoleChoice;

  if (name.length < 2) return { error: "Укажите имя (минимум 2 символа)." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Некорректный email." };
  if (!["FLORIST_PRIMARY", "FLORIST_SECONDARY", "CALL_CENTER"].includes(roleChoice)) {
    return { error: "Выберите роль." };
  }

  const dup = await prisma.user.findUnique({ where: { email } });
  if (dup) return { error: `Пользователь с email ${email} уже существует.` };

  const password = crypto.randomBytes(9).toString("base64url");
  const passwordHash = await hashPassword(password);
  const role = roleChoice === "CALL_CENTER" ? "CALL_CENTER" : "FLORIST";

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name, email, phone: phone || null, role, passwordHash, active: true },
    });
    if (role === "FLORIST") {
      await tx.florist.create({
        data: {
          userId: user.id,
          financeVisibility: roleChoice === "FLORIST_PRIMARY" ? "FULL" : "MAKER_ONLY",
        },
      });
    }
  });

  revalidatePath("/dashboard/users");
  revalidatePath("/dashboard/florists");
  return { success: true, email, password };
}

/**
 * Владелец правит существующего пользователя: имя, email, роль, статус и — при желании —
 * пароль. Пустое поле пароля означает «оставить текущий»: сам пароль нигде не читается и не
 * показывается, в БД лежит только hash (та же hashPassword, что при создании).
 *
 * Права проверяются на сервере (ownerOnly) — форму можно отправить в обход интерфейса.
 */
export async function ownerUpdateUser(
  _prev: unknown,
  formData: FormData
): Promise<{ error?: string; success?: true }> {
  await ownerOnly();

  const userId = String(formData.get("userId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as Role;
  const active = String(formData.get("active") ?? "") === "true";
  const newPassword = String(formData.get("newPassword") ?? "");

  if (!userId) return { error: "Не указан пользователь." };
  if (name.length < 2) return { error: "Укажите имя (минимум 2 символа)." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Некорректный email." };
  if (!["OWNER", "FLORIST", "CALL_CENTER"].includes(role)) return { error: "Выберите роль." };
  // Пустой пароль — штатный случай (не меняем). Заданный проверяем по длине.
  if (newPassword && newPassword.length < 8) return { error: "Пароль — минимум 8 символов." };

  const current = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!current) return { error: "Пользователь не найден." };

  // Email уникален: занят ли он ДРУГИМ пользователем.
  const dup = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (dup && dup.id !== userId) return { error: `Email ${email} уже занят другим пользователем.` };

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name,
        email,
        role,
        active,
        // Хеш перезаписываем ТОЛЬКО когда пароль реально ввели.
        ...(newPassword ? { passwordHash: await hashPassword(newPassword) } : {}),
      },
    });

    // Роль сменили на флориста, а профиля нет — заводим, иначе кабинет флориста будет
    // недоступен (requireFlorist требует и роль, и floristId). Существующий профиль и его
    // financeVisibility не трогаем.
    if (role === "FLORIST" && current.role !== "FLORIST") {
      const florist = await tx.florist.findUnique({ where: { userId }, select: { id: true } });
      if (!florist) await tx.florist.create({ data: { userId, financeVisibility: "MAKER_ONLY" } });
    }
  });

  revalidatePath("/dashboard/users");
  revalidatePath("/dashboard/florists");
  return { success: true };
}
