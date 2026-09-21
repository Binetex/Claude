import "server-only";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { OrderStatus } from "@/generated/prisma/enums";
import { DEFAULT_STORE_TZ, utcDayRangeForLocalToday } from "@/lib/tz";
import { ACCEPTED_ORDER_STATUSES } from "@/lib/statuses";
import {
  orderInclude,
  orderListInclude,
  serializeForOwner,
  serializeForCallCenter,
  serializeForFlorist,
  serializeOwnerListRow,
  serializeCallCenterListRow,
  serializeFloristListRow,
} from "./serialize";

export type OrderFilters = {
  preset?: "today" | "yesterday" | "tomorrow" | "all" | "done";
  date?: string; // YYYY-MM-DD
  from?: string;
  to?: string;
  status?: OrderStatus;
  siteId?: string;
  floristId?: string;
  search?: string;
  sortBy?: "deliveryDate" | "createdAt" | "orderStatus";
  sortDir?: "asc" | "desc";
  /** Пагинация. Без perPage выборка не ограничивается (поведение прежних вызовов). */
  page?: number;
  perPage?: number;
};

const DONE_STATUSES: OrderStatus[] = [
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
];

/** Границы календарного дня «YYYY-MM-DD» в UTC — под формат хранения deliveryDate. */
const utcDayStart = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const utcDayEnd = (ymd: string) => new Date(`${ymd}T23:59:59.999Z`);

/**
 * Цифры телефона из поисковой строки, пригодные для сравнения.
 *
 * Один и тот же номер приезжает к нам из Shopify, Woo, QUO и рук оператора и лежит в базе
 * как «3109048385», «+13109048385», «(310) 904-8385», «310-904-8385», «+1 (310) 904‑8385»
 * (последний — с неразрывным дефисом). Поиск подстрокой по сырому тексту совпадает ровно с
 * одним из этих видов, поэтому номер, скопированный из переписки, заказ не находил.
 *
 * Ведущая «1» у одиннадцатизначного отбрасывается: «+1 (310) 904-8385» и «3109048385» — один
 * и тот же номер, и ввод в любом из двух видов обязан находить оба.
 *
 * Короче семи цифр не ищем: «2026» из даты или «#20211» превратились бы в телефонный запрос
 * и притащили в выдачу случайные заказы.
 */
export function searchPhoneDigits(q: string): string {
  const digits = q.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length >= 7 ? local : "";
}

/**
 * Заказы, у которых телефон заказчика или получателя содержит эти цифры.
 *
 * Отдельным запросом, потому что сравнивать надо не колонку, а колонку БЕЗ форматирования, а
 * такого условия в Prisma-фильтре не выразить. Потолок в 200 строк: поиск по трём цифрам кода
 * города иначе вернул бы половину базы в оператор `IN`.
 */
async function orderIdsByPhone(digits: string): Promise<string[]> {
  if (!digits) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Order"
    WHERE regexp_replace(COALESCE("senderPhone", ''), '\D', '', 'g') LIKE ${`%${digits}%`}
       OR regexp_replace(COALESCE("recipientPhone", ''), '\D', '', 'g') LIKE ${`%${digits}%`}
    LIMIT 200`;
  return rows.map((r) => r.id);
}

async function buildWhere(f: OrderFilters): Promise<Prisma.OrderWhereInput> {
  const where: Prisma.OrderWhereInput = {};

  // Дата доставки. deliveryDate хранится как UTC-полночь ЛОКАЛЬНОГО дня доставки, поэтому
  // границы считаем строго в UTC («T00:00:00Z»), а не через локальный день процесса: иначе
  // при сервере не в UTC выборка съезжала бы на сутки. Сейчас прод в UTC — поведение то же.
  if (f.date) {
    where.deliveryDate = { gte: utcDayStart(f.date), lte: utcDayEnd(f.date) };
  } else if (f.from || f.to) {
    where.deliveryDate = {
      ...(f.from ? { gte: utcDayStart(f.from) } : {}),
      ...(f.to ? { lte: utcDayEnd(f.to) } : {}),
    };
  } else if (f.preset === "today" || f.preset === "tomorrow" || f.preset === "yesterday") {
    // «Вчера»/«Сегодня»/«Завтра» — по календарному дню в таймзоне магазина, как считают
    // дашборд и список закупки. Раньше здесь брался день ПРОЦЕССА (сервер в UTC), и каждый
    // вечер после 17:00 по Лос-Анджелесу вкладки показывали на сутки вперёд: UTC уже перешёл
    // на новый день, а у магазина он ещё не наступил.
    const { gte, lt } = utcDayRangeForLocalToday(DEFAULT_STORE_TZ);
    const DAY = 24 * 60 * 60 * 1000;
    const shift = f.preset === "tomorrow" ? DAY : f.preset === "yesterday" ? -DAY : 0;
    where.deliveryDate = { gte: new Date(gte.getTime() + shift), lt: new Date(lt.getTime() + shift) };
  }

  if (f.preset === "done") where.orderStatus = { in: DONE_STATUSES };
  // Фильтр «Принят» ищет всю группу: пользователь выбирает смысл, а не значение enum.
  // «Начат» (IN_PROGRESS) в группу не входит — это отдельный смысл и отдельный пункт.
  else if (f.status && ACCEPTED_ORDER_STATUSES.includes(f.status)) where.orderStatus = { in: ACCEPTED_ORDER_STATUSES };
  else if (f.status) where.orderStatus = f.status;

  if (f.siteId) where.siteId = f.siteId;
  if (f.floristId) where.currentFloristId = f.floristId;

  if (f.search) {
    const q = f.search.trim();
    // В списке номер показан как «#20211», а в БД лежит «THEFLOW-20211»: скопированный из
    // интерфейса номер с решёткой не находился. Ищем и по введённому тексту, и по варианту
    // без ведущих «#»/«№» — второй нужен только для номера заказа.
    const bare = q.replace(/^[#№]+\s*/, "");
    // Телефон ищется отдельно: в базе он лежит в десятке видов сразу, и подстрокой
    // по сырому тексту находится только один из них (см. searchPhoneDigits).
    const phoneIds = await orderIdsByPhone(searchPhoneDigits(q));
    where.OR = [
      { orderNumber: { contains: q, mode: "insensitive" } },
      ...(bare && bare !== q ? [{ orderNumber: { contains: bare, mode: "insensitive" as const } }] : []),
      { senderName: { contains: q, mode: "insensitive" } },
      { recipientName: { contains: q, mode: "insensitive" } },
      { recipientPhone: { contains: q, mode: "insensitive" } },
      { senderPhone: { contains: q, mode: "insensitive" } },
      { addressLine: { contains: q, mode: "insensitive" } },
      ...(phoneIds.length ? [{ id: { in: phoneIds } }] : []),
    ];
  }

  return where;
}

/**
 * Дефолт (без явного sortBy) — по ДАТЕ ДОСТАВКИ, по убыванию: сверху заказы с ближайшей/
 * недавней датой доставки (которые вот-вот нужно доставлять), внизу — доставленные давно.
 * Тай-брейк — по дате размещения заказа (externalCreatedAt), новее выше.
 * Явный выбор сортировки в фильтрах имеет приоритет.
 */
/**
 * Список показывает ОДИН БУДУЩИЙ день доставки — только тогда ручной порядок имеет смысл.
 *
 * «Все» и диапазон дат расставлять нечего: очередь у флориста существует внутри дня, а не
 * поперёк недели. «Вчера» и «Готовые» — тоже: там заказы уже сделаны, и очередь на них
 * показывала бы работу, которую никто уже не выполнит в этом порядке.
 *
 * Произвольная дата (`?date=`) сюда попадает: владелец открывает конкретный день, чтобы
 * разложить его заранее, и чаще всего это день будущий. Проверять дату на «не прошла ли»
 * пришлось бы в часах магазина, а цена ошибки здесь — лишний столбик в 22 пикселя.
 */
export function isSingleDayView(f: OrderFilters): boolean {
  if (f.sortBy) return false; // человек выбрал сортировку сам — его выбор сильнее
  return f.preset === "today" || f.preset === "tomorrow" || !!f.date;
}

/**
 * Очередь дня: сначала расставленное руками, потом всё остальное. Тот же порядок использует
 * действие со стрелками (modules/orders/reorder.ts) — если эти два разойдутся, стрелка будет
 * менять местами не то, что человек видит на экране.
 */
export const DAY_QUEUE_ORDER: Prisma.OrderOrderByWithRelationInput[] = [
  { sortIndex: { sort: "asc", nulls: "last" } },
  { externalCreatedAt: "desc" },
  { id: "desc" },
];

function buildOrderBy(f: OrderFilters): Prisma.OrderOrderByWithRelationInput[] {
  // Значение приходит из адресной строки, а Prisma принимает строго "asc"/"desc": на любом
  // другом ("DESC" из руками собранной ссылки) запрос падает валидацией, и сотрудник видит
  // не список, а общий экран ошибки.
  // Один день на экране — показываем его очередью: сверху то, что флористу делать первым.
  if (isSingleDayView(f)) return DAY_QUEUE_ORDER;

  const dir: Prisma.SortOrder = f.sortDir === "desc" ? "desc" : "asc";
  // id в конце — тай-брейк: без него заказы с одинаковой датой могут переставляться между
  // страницами (порядок неустойчив), и один и тот же заказ попадёт на две страницы либо ни на одну.
  const tail: Prisma.OrderOrderByWithRelationInput = { id: "desc" };
  if (f.sortBy === "orderStatus") return [{ orderStatus: dir }, { deliveryDate: "desc" }, tail];
  if (f.sortBy === "deliveryDate") return [{ deliveryDate: dir }, { externalCreatedAt: "desc" }, tail];
  if (f.sortBy === "createdAt") return [{ externalCreatedAt: dir }, tail]; // «Дата создания» = дата размещения заказа
  // Дефолт: ближайшие к доставке сверху, а ВНУТРИ дня — та же очередь, что владелец расставил
  // на вкладке «Сегодня». Иначе на «Все» тот же день лежал бы в другом порядке, и непонятно,
  // какой из двух списков правда.
  return [{ deliveryDate: "desc" }, { sortIndex: { sort: "asc", nulls: "last" } }, { externalCreatedAt: "desc" }, tail];
}

/** take/skip только когда задан perPage — иначе выборка полная, как раньше. */
function buildPage(f: OrderFilters): { take?: number; skip?: number } {
  if (!f.perPage || f.perPage < 1) return {};
  return { take: f.perPage, skip: (Math.max(1, f.page ?? 1) - 1) * f.perPage };
}

// ─────────── ВЛАДЕЛЕЦ ───────────
export async function listForOwner(f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: await buildWhere(f),
    // Списки ходят с ЛЁГКИМ include: без переписки, назначений и Airwallex. Полный — только
    // у карточек (getFor*), где эти связи действительно показываются.
    include: orderListInclude,
    orderBy: buildOrderBy(f),
    ...buildPage(f),
  });
  return orders.map(serializeOwnerListRow);
}

/** Сколько заказов под фильтр всего — для пейджера и счётчика в заголовке. */
export async function countOrders(f: OrderFilters = {}) {
  return prisma.order.count({ where: await buildWhere(f) });
}

export async function getForOwner(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  return order ? serializeForOwner(order) : null;
}

// ─────────── КОЛЛ-ЦЕНТР ───────────
export async function listForCallCenter(f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: await buildWhere(f),
    include: orderListInclude,
    orderBy: buildOrderBy(f),
    ...buildPage(f),
  });
  return orders.map(serializeCallCenterListRow);
}

export async function getForCallCenter(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  return order ? serializeForCallCenter(order) : null;
}

// ─────────── ФЛОРИСТ ───────────
// Строго только заказы, где флорист является ТЕКУЩИМ исполнителем.
/** Условие «заказы, где этот флорист — ТЕКУЩИЙ исполнитель». Общее для списка и счётчика,
 *  чтобы пейджер не разошёлся с выборкой. */
async function floristWhere(floristId: string, f: OrderFilters): Promise<Prisma.OrderWhereInput> {
  const where = await buildWhere({ ...f, floristId: undefined });
  where.currentFloristId = floristId;
  return where;
}

export async function listForFlorist(floristId: string, f: OrderFilters = {}) {
  const orders = await prisma.order.findMany({
    where: await floristWhere(floristId, f),
    include: orderListInclude,
    orderBy: buildOrderBy(f),
    ...buildPage(f),
  });
  return orders.map(serializeFloristListRow);
}

/** Сколько заказов флориста под фильтр всего — для пейджера и счётчика в заголовке. */
export async function countForFlorist(floristId: string, f: OrderFilters = {}) {
  return prisma.order.count({ where: await floristWhere(floristId, f) });
}

export async function getForFlorist(id: string, floristId: string) {
  const order = await prisma.order.findFirst({
    where: { id, currentFloristId: floristId },
    include: orderInclude,
  });
  return order ? serializeForFlorist(order) : null;
}
