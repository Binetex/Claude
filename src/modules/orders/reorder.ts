import "server-only";
/**
 * Ручная очередь заказов внутри дня доставки.
 *
 * Зачем: флористу важно не только ЧТО сделать сегодня, но и В КАКОМ ПОРЯДКЕ — ранняя доставка
 * раньше, поздняя позже, срочное вперёд. Порядок задаёт владелец, который видит весь день
 * целиком; флорист получает свой срез в той же последовательности и ничего не решает сам.
 *
 * Очередь ОДНА на день, а не на флориста. Так владелец раскладывает день один раз, а не по
 * разу на каждого исполнителя, и переназначение заказа другому флористу не сбивает порядок.
 *
 * Сохраняется ЦЕЛИКОМ, а не по одному шагу. Шаговая запись означала бы запрос на каждое
 * нажатие: переезд заказа с двенадцатого места на первое — одиннадцать кругов до сервера, да
 * ещё и с гонкой между ними (второй запрос читает порядок раньше, чем ляжет первый, и база
 * расходится с экраном молча). Полный снимок этого лишён по построению: пришёл список — он и
 * стал правдой.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DAY_QUEUE_ORDER } from "./queries";

export type ReorderResult = { ok?: true; error?: string };

/**
 * Записывает порядок дня по списку, который человек видел на экране.
 *
 * `orderIds` — ВИДИМЫЕ заказы в новом порядке. Скрытые фильтром заказы того же дня остаются
 * ровно на своих местах: видимые лишь переставляются между собственными позициями в общей
 * последовательности. Иначе расстановка при включённом фильтре по магазину выбрасывала бы
 * чужие заказы в конец дня, и владелец ломал бы очередь, не видя чем.
 */
export async function saveDayQueue(prisma: PrismaClient, orderIds: string[]): Promise<ReorderResult> {
  if (orderIds.length === 0) return { ok: true };

  const first = await prisma.order.findUnique({
    where: { id: orderIds[0] },
    select: { deliveryDate: true },
  });
  if (!first?.deliveryDate) return { error: "У заказа нет даты доставки — его некуда поставить в очередь." };

  const day = await prisma.order.findMany({
    where: { deliveryDate: first.deliveryDate },
    orderBy: DAY_QUEUE_ORDER,
    select: { id: true, sortIndex: true },
  });
  const seq = day.map((d) => d.id);

  // Берём только те присланные id, что и правда в этом дне: список приехал из браузера, а
  // заказу могли поменять дату, пока владелец расставлял.
  const inDay = new Set(seq);
  const incoming = orderIds.filter((id) => inDay.has(id));
  if (incoming.length === 0) return { ok: true };

  const moving = new Set(incoming);
  const slots: number[] = [];
  seq.forEach((id, i) => {
    if (moving.has(id)) slots.push(i);
  });
  // Позиций ровно столько же, сколько переставляемых заказов: раскладываем присланный порядок
  // по этим позициям, остальные строки не трогаем вовсе.
  slots.forEach((slot, k) => {
    seq[slot] = incoming[k]!;
  });

  const current = new Map(day.map((d) => [d.id, d.sortIndex]));
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  seq.forEach((id, index) => {
    // Пишем только изменившимся: день — это десятки заказов, и переписывать их все на каждое
    // сохранение незачем.
    if (current.get(id) !== index) {
      updates.push(prisma.order.update({ where: { id }, data: { sortIndex: index } }));
    }
  });
  if (updates.length) await prisma.$transaction(updates);
  return { ok: true };
}
