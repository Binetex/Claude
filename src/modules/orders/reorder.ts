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
 * Перестановка переписывает `sortIndex` всем заказам дня, а не двум соседям. У заказов, которых
 * ещё не касались, индекс пуст, и обмен двух значений оставил бы список в прежнем виде.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { DAY_QUEUE_ORDER } from "./queries";

export type ReorderResult = { ok?: true; error?: string };

/**
 * Двигает заказ на одну позицию в очереди своего дня.
 *
 * `visibleIds` — порядок плашек НА ЭКРАНЕ у того, кто нажал. Он нужен из-за фильтров: когда
 * список сужен магазином или флористом, соседняя плашка на экране может быть не соседней в
 * дне, а стрелка обязана двигать туда, куда смотрит человек. Без этого нажатие «вверх»
 * иногда не меняло бы на экране ничего.
 */
export async function moveOrderInDay(
  prisma: PrismaClient,
  input: { orderId: string; direction: "up" | "down"; visibleIds: string[] }
): Promise<ReorderResult> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { deliveryDate: true },
  });
  if (!order) return { error: "Заказ не найден." };
  if (!order.deliveryDate) return { error: "У заказа нет даты доставки — его некуда поставить в очередь." };

  const day = await prisma.order.findMany({
    where: { deliveryDate: order.deliveryDate },
    orderBy: DAY_QUEUE_ORDER,
    select: { id: true, sortIndex: true },
  });

  const seq = day.map((d) => d.id);
  const from = seq.indexOf(input.orderId);
  if (from === -1) return { error: "Заказ не найден в своём дне." };

  const visible = input.visibleIds.filter((id) => seq.includes(id));
  const at = visible.indexOf(input.orderId);
  const neighbour = at === -1 ? undefined : visible[input.direction === "up" ? at - 1 : at + 1];
  // Край списка — не ошибка: человек просто упёрся, и говорить ему об этом нечего.
  if (!neighbour) return { ok: true };

  const [moving] = seq.splice(from, 1);
  const target = seq.indexOf(neighbour);
  seq.splice(input.direction === "up" ? target : target + 1, 0, moving!);

  // Пишем только тем, у кого позиция реально изменилась: день — это десятки заказов, и
  // переписывать их все на каждое нажатие незачем.
  const current = new Map(day.map((d) => [d.id, d.sortIndex]));
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  seq.forEach((id, index) => {
    if (current.get(id) !== index) {
      updates.push(prisma.order.update({ where: { id }, data: { sortIndex: index } }));
    }
  });
  if (updates.length) await prisma.$transaction(updates);
  return { ok: true };
}
