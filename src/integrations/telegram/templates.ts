import { getAppUrl } from "@/lib/appUrl";
import { fmtTimeWindow } from "@/lib/format";
import { CAPTION_LIMIT, type TelegramButton } from "./sender";
import type { TelegramEventType } from "./registry";
import { recipientMapsUrl } from "@/components/orders/address";

/**
 * Тексты внутренних уведомлений. Чистые функции — тестируются без сети и БД.
 *
 * ВАЖНО: флористу НЕ показываем финансы владельца (прибыль, себестоимость доставки, цену
 * клиента). Открытку флористу тоже не показываем (по требованию владельца).
 */
export type OrderSnapshot = {
  id: string;
  orderNumber: string;
  siteName: string;
  deliveryDate: Date | null;
  deliveryWindow: string | null;
  recipientName: string | null;
  /** Заказчик — нужен только сообщению колл-центру: отзыв просят у того, кто платил. */
  senderName?: string | null;
  senderPhone?: string | null;
  addressLine: string | null;
  apartment: string | null;
  city: string | null;
  zip: string | null;
  cardMessage: string | null;
  deliveryInstructions: string | null;
  /**
   * Фото, прикреплённое К САМОЙ карточке. Заполнено только когда фото ровно одно: тогда
   * сообщение уходит как фото с подписью и кнопками. Если фото несколько — здесь null,
   * а все они уходят альбомом (см. albumUrls), и подпись не ограничивается лимитом фото.
   */
  imageUrl: string | null;
  /**
   * Все фото позиций заказа — отдельным сообщением-альбомом ПЕРЕД карточкой. Непусто только
   * когда фото больше одного. Без повторов: в заказе из двух одинаковых букетов фото одно.
   * На рендер текста не влияет, лежит здесь потому, что снимок заказа один на всё сообщение.
   */
  albumUrls: string[];
  items: { name: string; variantName: string | null; quantity: number; composition: string | null }[];
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const line = (label: string, value: string | null | undefined) => (value && value.trim() ? `${label}: ${esc(value.trim())}\n` : "");

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Дата доставки человеку: «24 Jul», а не «2026-07-24».
 *
 * Читаем ИМЕННО UTC-части: `Order.deliveryDate` — это UTC-полночь локального дня доставки,
 * и локальная таймзона сервера сдвинула бы день на сутки (см. CLAUDE.md).
 */
function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** Адрес одной строкой — и для текста, и для запроса в Google Maps. */
export function addressText(o: OrderSnapshot): string | null {
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
  return `\n🌷 <b>Состав:</b>\n${rows.join("\n")}\n`;
}

export function floristOrderUrl(orderId: string): string {
  return `${getAppUrl()}/dashboard/f/${orderId}`;
}

export function ownerOrderUrl(orderId: string): string {
  return `${getAppUrl()}/dashboard/orders/${orderId}`;
}

export function callCenterOrderUrl(orderId: string): string {
  return `${getAppUrl()}/dashboard/cc/${orderId}`;
}

/** Ссылка на карту — общая с дашбордом. Отдельной сборки здесь быть не должно. */
export const googleMapsUrl = recipientMapsUrl;

/** Шапка со временем и адресом — общая для «новый заказ» и «передан». Время и адрес выделены. */
function deliveryHead(o: OrderSnapshot): string {
  const date = fmtDate(o.deliveryDate);
  const win = fmtTimeWindow(o.deliveryWindow);
  // Время доставки в течение дня — жирным: флористу это важнее даты.
  const when = [date ? `📅 ${esc(date)}` : "", win ? `⏰ <b>${esc(win)}</b>` : ""].filter(Boolean).join("   ");
  const addr = addressText(o);
  return (
    (when ? `${when}\n` : "") +
    (o.recipientName ? `👤 ${esc(o.recipientName)}\n` : "") +
    (addr ? `📍 <b>${esc(addr)}</b>\n` : "")
  );
}

/**
 * Основное сообщение флористу. Идёт подписью под фото букета (если оно есть). Открытку не
 * показываем; адрес и время доставки выделены.
 */
export function renderFloristMessage(o: OrderSnapshot, opts: { reassigned?: boolean; floristName?: string | null } = {}): string {
  const head = opts.reassigned ? "🔄 <b>Заказ передан</b>" : "🌸 <b>Новый заказ</b>";
  const who = opts.floristName ? ` → ${esc(opts.floristName)}` : "";
  const body =
    `${head}${who} · <b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    deliveryHead(o) +
    itemsBlock(o) +
    line("📝 Инструкции", o.deliveryInstructions);
  return capForPhoto(body.trimEnd(), !!o.imageUrl);
}

/**
 * Сообщение прежнему флористу: заказ у него забрали. Состав уже не нужен — важно, что заказ
 * не его. Отправляется/правится ЕГО же ботом.
 */
export function renderFloristHandedOver(o: OrderSnapshot, toName: string | null): string {
  const body =
    `↪️ <b>Заказ передан${toName ? ` → ${esc(toName)}` : ""}</b> · <b>${esc(o.orderNumber)}</b>\n\n` +
    deliveryHead(o) +
    `\nЭтот заказ больше не за вами.`;
  return capForPhoto(body.trimEnd(), !!o.imageUrl);
}

/** У фото подпись ограничена 1024 символами; текст без фото — нет. Обрезаем аккуратно. */
function capForPhoto(text: string, isPhoto: boolean): string {
  if (!isPhoto || text.length <= CAPTION_LIMIT) return text;
  return text.slice(0, CAPTION_LIMIT - 1).trimEnd() + "…";
}

/** Владельцу: новый заказ. Финансы намеренно не включаем — это поток, а не отчёт. */
export function renderOwnerCreated(o: OrderSnapshot, paymentLabel: string): string {
  return (
    `🆕 <b>Новый заказ</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Оплата", paymentLabel) +
    line("Доставка", [fmtDate(o.deliveryDate), fmtTimeWindow(o.deliveryWindow)].filter(Boolean).join(" ")) +
    line("Получатель", o.recipientName) +
    line("Адрес", addressText(o))
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

/** Платёж Airwallex завис дольше порога. */
export function renderOwnerPendingTooLong(o: OrderSnapshot, minutes: string | null, status: string | null): string {
  return (
    `⏳ <b>Оплата долго в ожидании</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Статус Airwallex", status) +
    line("В ожидании", minutes ? `${minutes} мин` : null) +
    line("Доставка", fmtDate(o.deliveryDate))
  ).trimEnd();
}

/** Airwallex и WooCommerce разошлись — самый важный сигнал сверки. */
export function renderOwnerStatusMismatch(o: OrderSnapshot, mismatchType: string | null, normalized: string | null): string {
  const human =
    mismatchType === "airwallex_paid_woo_unpaid" ? "Airwallex подтвердил оплату, а в WooCommerce её нет"
    : mismatchType === "airwallex_failed_woo_paid" ? "В WooCommerce заказ оплачен, а Airwallex сообщает об отказе"
    : "Статусы оплаты расходятся";
  return (
    `❗️ <b>Расхождение статуса оплаты</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Что не так", human) +
    line("Airwallex", normalized)
  ).trimEnd();
}

/** Платёж не найден в Airwallex после повторов. */
export function renderOwnerPaymentNotFound(o: OrderSnapshot): string {
  return (
    `🔍 <b>Платёж не найден в Airwallex</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    `Intent не найден после нескольких проверок — возможно, оплата шла другим способом.`
  ).trimEnd();
}

/**
 * Проблемные статусы — человеческими словами. Сырой код статуса (FAILED) в сообщении не
 * показывается: получатель уведомления должен понять, что случилось, не зная словаря Burq.
 */
const DELIVERY_PROBLEM_LABEL: Record<string, string> = {
  FAILED: "курьер не смог доставить заказ",
  CANCELLED: "доставка отменена",
  PROBLEM: "у курьера возникла проблема с доставкой",
};

function deliveryProblemLabel(status: string): string {
  return DELIVERY_PROBLEM_LABEL[status] ?? `доставка в статусе ${status}`;
}

/**
 * Тексты проблем доставки построены одинаково: что случилось → что за заказ → что делать.
 * Требование владельца: максимально просто, без словаря статусов, с действием в конце —
 * и ОДИН И ТОТ ЖЕ текст владельцу и флористу (florist-события рендерят эти же функции,
 * различаются только бот, чат и кнопки).
 */
/**
 * Клиент ответил, когда готов принять букет. Текст один у владельца и флориста: тот, кто
 * везёт, должен увидеть слова клиента, а не пересказ.
 */
export function renderCustomerReadyTime(o: OrderSnapshot, readyTime: string, quote: string | null): string {
  return (
    `🕒 <b>Клиент назвал время</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    `Готов принять: <b>${esc(readyTime)}</b>\n` +
    line("Сообщение", quote) +
    `\n` +
    line("Получатель", o.recipientName) +
    line("Адрес", addressText(o)) +
    line("Доставка", [fmtDate(o.deliveryDate), fmtTimeWindow(o.deliveryWindow)].filter(Boolean).join(", ")) +
    `\nЗаписано в заметку заказа.`
  ).trimEnd();
}

/**
 * Клиент просит позвонить. Текст один владельцу и оператору: телефон того, кто написал, и его
 * слова — чтобы звонящий знал, о чём разговор, не открывая карточку.
 */
export function renderCustomerCallRequest(o: OrderSnapshot, quote: string | null, phone: string | null, note: string | null): string {
  return (
    `📞 <b>${note ? `${esc(note)} · ` : ""}Клиент просит позвонить</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Телефон", phone) +
    line("Сообщение", quote) +
    `\n` +
    line("Заказчик", o.senderName ?? null) +
    line("Получатель", o.recipientName) +
    line("Доставка", [fmtDate(o.deliveryDate), fmtTimeWindow(o.deliveryWindow)].filter(Boolean).join(", ")) +
    `\nПозвоните клиенту.`
  ).trimEnd();
}

export function renderOwnerDeliveryProblem(o: OrderSnapshot, status: string, safeReason: string | null): string {
  return (
    `🚨 <b>Проблема с доставкой</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    `Что случилось: ${esc(deliveryProblemLabel(status))}.\n` +
    line("Причина от службы доставки", safeReason) +
    `\n` +
    line("Получатель", o.recipientName) +
    line("Адрес", addressText(o)) +
    line("Доставка", [fmtDate(o.deliveryDate), fmtTimeWindow(o.deliveryWindow)].filter(Boolean).join(", ")) +
    `\nЧто делать: проверьте доставку в Burq — что случилось и что с ней дальше.`
  ).trimEnd();
}

/**
 * Курьеров на маршрут не нашлось. Сообщение адресное: владельцу нужно решить, что делать с
 * КОНКРЕТНЫМ заказом — передать другому флористу, сменить точку забора или везти самим.
 *
 * Про срок годности котировок сказано прямо: проверка сделана в момент создания черновика
 * (ночью), и к моменту доставки курьеры могут появиться. Молчать об этом нельзя — иначе
 * сообщение читается как приговор.
 */
export function renderOwnerNoCouriers(o: OrderSnapshot, checkedAtLabel: string | null): string {
  return (
    `🚕 <b>Не нашлось курьеров на маршрут</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    `Что случилось: служба доставки не нашла ни одного курьера на этот адрес` +
    (checkedAtLabel ? ` (проверено в ${esc(checkedAtLabel)})` : "") +
    `. Проверка была при создании черновика — ближе к доставке курьеры могут появиться.\n\n` +
    line("Получатель", o.recipientName) +
    line("Адрес", addressText(o)) +
    line("Доставка", [fmtDate(o.deliveryDate), fmtTimeWindow(o.deliveryWindow)].filter(Boolean).join(", ")) +
    `\nЧто делать: выберите другой адрес пикапа — в кабинете флориста, раздел ` +
    `«Мои точки забора», кнопка у нужного адреса.`
  ).trimEnd();
}

/**
 * Задача оператору колл-центра: попросить у клиента отзыв.
 *
 * Отзыв просят у ЗАКАЗЧИКА, а не у получателя: платил и выбирал он, и телефон в заказе есть
 * именно его. Получателя всё же называем — по нему оператор поймёт, о каком букете речь.
 *
 * Это задача человеку, а не уведомление о событии, поэтому сказано прямо, что нужно сделать.
 */
export function renderAskReview(o: OrderSnapshot): string {
  return (
    `⭐ <b>Попросить отзыв</b>\n` +
    `<b>${esc(o.orderNumber)}</b> · ${esc(o.siteName)}\n\n` +
    line("Заказчик", o.senderName ?? null) +
    line("Телефон", o.senderPhone ?? null) +
    line("Получатель", o.recipientName) +
    line("Доставка", fmtDate(o.deliveryDate)) +
    `\nВладелец отметил заказ: свяжитесь с заказчиком и попросите оставить отзыв.`
  ).trimEnd();
}

/**
 * Кнопки под сообщением. Флорист получает «Open Order» + «Google Maps» (если есть адрес):
 * карта открывает адрес получателя. Владелец — только «Open Order».
 */
export function buttonsFor(type: TelegramEventType, o: OrderSnapshot): TelegramButton[] {
  // Оператор открывает СВОЮ карточку заказа: в кабинет владельца у него нет доступа.
  if (type === "order.ask_review" || type === "customer.call_request_cc") return [{ text: "Open Order", url: callCenterOrderUrl(o.id) }];
  const forFlorist =
    type === "order.assigned" ||
    type === "order.handed_over" ||
    type === "delivery.problem_florist" ||
    type === "delivery.no_couriers_florist" ||
    type === "customer.ready_time_florist";
  if (!forFlorist) return [{ text: "Open Order", url: ownerOrderUrl(o.id) }];
  const buttons: TelegramButton[] = [{ text: "🧾 Open Order", url: floristOrderUrl(o.id) }];
  const addr = addressText(o);
  if (addr) buttons.push({ text: "📍 Google Maps", url: googleMapsUrl(o) });
  return buttons;
}
