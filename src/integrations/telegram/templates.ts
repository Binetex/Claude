import { getAppUrl } from "@/lib/appUrl";
import type { TelegramEventType } from "./registry";

/**
 * Тексты внутренних уведомлений. Чистые функции — тестируются без сети и БД.
 *
 * ВАЖНО: флористу НЕ показываем финансы владельца (прибыль, себестоимость доставки, цену
 * клиента) — состав уведомления повторяет то, что флорист и так видит в своей карточке заказа.
 */
export type OrderSnapshot = {
  id: string;
  orderNumber: string;
  siteName: string;
  deliveryDate: Date | null;
  deliveryWindow: string | null;
  recipientName: string | null;
  addressLine: string | null;
  apartment: string | null;
  city: string | null;
  zip: string | null;
  cardMessage: string | null;
  deliveryInstructions: string | null;
  items: { name: string; variantName: string | null; quantity: number; composition: string | null }[];
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const line = (label: string, value: string | null | undefined) => (value && value.trim() ? `${label}: ${esc(value.trim())}\n` : "");

function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function address(o: OrderSnapshot): string | null {
  const parts = [o.addressLine, o.apartment, o.city, o.zip].filter((p) => p && p.trim());
  return parts.length ? parts.join(", ") : null;
}

function itemsBlock(o: OrderSnapshot): string {
  if (o.items.length === 0) return "";
  const rows = o.items.map((i) => {
    const title = `${i.name}${i.variantName ? ` — ${i.variantName}` : ""} × ${i.quantity}`;
    const comp = i.composition?.trim() ? `\n   ${esc(i.composition.trim()).split("\n").join("\n   ")}` : "";
    return `• ${esc(title)}${comp}`;
  });
  return `\nСостав:\n${rows.join("\n")}\n`;
}

export function floristOrderUrl(orderId: string): string {
  return `${getAppUrl()}/dashboard/f/${orderId}`;
}

export function ownerOrderUrl(orderId: string): string {
  return `${getAppUrl()}/dashboard/orders/${orderId}`;
}

/** Основное сообщение флористам. `reassigned` меняет только заголовок — тело одинаковое. */
export function renderFloristMessage(o: OrderSnapshot, opts: { reassigned?: boolean; floristName?: string | null } = {}): string {
  const head = opts.reassigned ? "🔄 <b>Заказ передан</b>" : "🌸 <b>Новый заказ</b>";
  const who = opts.floristName ? ` → ${esc(opts.floristName)}` : "";
  return (
    `${head}${who}\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Доставка", [fmtDate(o.deliveryDate), o.deliveryWindow].filter(Boolean).join(" ")) +
    line("Получатель", o.recipientName) +
    line("Адрес", address(o)) +
    itemsBlock(o) +
    line("Открытка", o.cardMessage) +
    line("Инструкции", o.deliveryInstructions)
  ).trimEnd();
}

/** Владельцу: новый заказ. Финансы намеренно не включаем — в MVP это поток, а не отчёт. */
export function renderOwnerCreated(o: OrderSnapshot, paymentLabel: string): string {
  return (
    `🆕 <b>Новый заказ</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Оплата", paymentLabel) +
    line("Доставка", [fmtDate(o.deliveryDate), o.deliveryWindow].filter(Boolean).join(" ")) +
    line("Получатель", o.recipientName) +
    line("Адрес", address(o))
  ).trimEnd();
}

export function renderOwnerPaymentProblem(o: OrderSnapshot, safeReason: string): string {
  return (
    `⚠️ <b>Проблема с оплатой</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Причина", safeReason) +
    line("Доставка", fmtDate(o.deliveryDate))
  ).trimEnd();
}

export function renderOwnerDeliveryProblem(o: OrderSnapshot, status: string, safeReason: string | null): string {
  return (
    `🚨 <b>Проблема с доставкой</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Статус", status) +
    line("Деталь", safeReason) +
    line("Получатель", o.recipientName)
  ).trimEnd();
}

/**
 * Сообщение прежнему флористу: заказ у него забрали. Полный состав уже не нужен — важно, что
 * заказ больше не его. Отправляется ЕГО ботом (чужое сообщение отредактировать нельзя).
 */
export function renderFloristHandedOver(o: OrderSnapshot, toName: string | null): string {
  return (
    `↪️ <b>Заказ передан${toName ? ` → ${esc(toName)}` : ""}</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Доставка", [fmtDate(o.deliveryDate), o.deliveryWindow].filter(Boolean).join(" ")) +
    line("Получатель", o.recipientName) +
    `\nЭтот заказ больше не за вами.`
  ).trimEnd();
}

export function buttonFor(type: TelegramEventType, orderId: string): { text: string; url: string } {
  const forFlorist = type === "order.assigned" || type === "order.handed_over";
  return { text: "Open Order", url: forFlorist ? floristOrderUrl(orderId) : ownerOrderUrl(orderId) };
}
