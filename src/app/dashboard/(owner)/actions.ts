"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { requireRole } from "@/lib/rbac";
import { hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OrderStatus, FloristFinanceVisibility } from "@/generated/prisma/enums";
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

async function ownerOnly() {
  await requireRole("OWNER");
}

export async function ownerSetOrderStatus(orderId: string, status: OrderStatus) {
  await ownerOnly();
  await prisma.order.update({ where: { id: orderId }, data: { orderStatus: status } });
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
  await ownerOnly();
  await setManualFloristPrice(orderId, amount);
  revalidatePath(`/dashboard/orders/${orderId}`);
}

export async function ownerReassign(
  orderId: string,
  floristId: string,
  keepManualPrice: boolean
) {
  await ownerOnly();
  await reassignManual(orderId, floristId, keepManualPrice);
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
  revalidatePath("/dashboard");
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
