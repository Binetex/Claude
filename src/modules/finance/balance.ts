import "server-only";
/**
 * Сколько должны флористу.
 *
 * Разделение, на котором держится весь модуль после перестройки:
 *
 *   ВЫВОДИМОЕ считается и нигде не хранится — заработок. Он целиком следует из данных:
 *   у основного флориста это доля от прибыли посчитанных дней, у второстепенного — сумма
 *   фиксированных цен его доставленных заказов минус дополнительные расходы по ним.
 *
 *   РЕШЁННОЕ записывается и не меняется — выплаты, бонусы, ручные корректировки. Это факты
 *   о том, что человек сделал, а не следствия данных.
 *
 * Отсюда исчезает целый класс механики: начисления больше не строки в книге, а значит нет
 * ни сторно, ни корректировок, ни ключей идемпотентности, ни расхождения между «числом на
 * экране» и «числом в книге». Пересчитался день — заработок изменился сам.
 *
 * Долг = заработано + бонусы − удержания − выплачено ± корректировки.
 */
import { cache } from "react";
import { prisma } from "@/lib/db";
import { toNumber } from "@/lib/money";
import { dayShareCents } from "./dayCalc";
import { accrualGate, primaryShareGate } from "./config";

export type FloristBalance = {
  floristId: string;
  model: "PRIMARY" | "SECONDARY" | null;
  /** Заработано: выводится из данных, не хранится. */
  earnedCents: number;
  /** Удержания за дополнительные расходы по заказам (только у второстепенного). */
  deductionCents: number;
  bonusCents: number;
  paidCents: number;
  adjustmentCents: number;
  /** К выплате. Может быть отрицательным — это переплата, и обнулять её нельзя. */
  outstandingCents: number;
  /** Из чего сложился заработок — для экрана, без отдельного запроса. */
  detail: { days?: number; orders?: number };
};

/**
 * Заработок основного флориста: доля от прибыли ПОСЧИТАННЫХ дней.
 *
 * Неполные дни не в счёт: у них распределяемой прибыли нет по построению. Процент берётся
 * текущий — периодов действия у него больше нет, и это осознанно: история дней хранится
 * своими строками, а не восстанавливается из датированных настроек.
 */
async function primaryEarned(profileId: string, sharePercentBp: number | null) {
  const gate = primaryShareGate();
  if (!gate.enabled || sharePercentBp == null) return { cents: 0, days: 0 };

  const days = await prisma.dayFinance.findMany({
    where: { financeProfileId: profileId, complete: true, day: { gte: gate.startDate } },
    select: { distributableCents: true },
  });

  // Отсечка «не ниже нуля» применяется к КАЖДОМУ дню, а не к сумме: убыточный день не
  // должен съедать заработок соседних. Внутри дня убыток заказа гасится другими заказами
  // того же дня — это разные уровни, и объединять их нельзя.
  const cents = days.reduce((a, d) => a + dayShareCents(d.distributableCents, sharePercentBp), 0);
  return { cents, days: days.length };
}

/**
 * Заработок второстепенного флориста: сумма фиксированных цен доставленных заказов.
 *
 * Цена берётся из снимка `Order.floristTotal`, зафиксированного при назначении, — она
 * обязана совпадать с той, которую флорист видел в карточке. Ноль означает «цена не
 * задана»: такой заказ в заработок не входит и попадает в разбор.
 */
async function secondaryEarned(floristId: string) {
  const gate = accrualGate();
  if (!gate.enabled) return { cents: 0, orders: 0, deductionCents: 0 };

  const orders = await prisma.order.findMany({
    where: {
      currentFloristId: floristId,
      orderStatus: "DELIVERED",
      deliveryDate: { gte: gate.startDate },
    },
    select: { id: true, floristTotal: true },
  });

  const cents = orders.reduce((a, o) => a + Math.max(Math.round(toNumber(o.floristTotal) * 100), 0), 0);

  // Дополнительные расходы по его заказам вычитаются доллар в доллар: фиксированную цену
  // уменьшать нечем, поэтому расход бьёт по заработку напрямую.
  const expenses = await prisma.orderAdditionalExpense.aggregate({
    where: { orderId: { in: orders.map((o) => o.id) }, reversedAt: null },
    _sum: { amountCents: true },
  });

  return { cents, orders: orders.length, deductionCents: expenses._sum.amountCents ?? 0 };
}

/**
 * Записанные решения владельца: выплаты, бонусы, корректировки И ИХ ОТМЕНЫ.
 *
 * `CORRECTION` обязателен в этом списке. Отмена бонуса или ручной правки пишется именно этим
 * типом (`reversalTypeFor`: всё, кроме PAYMENT, становится CORRECTION), и пока его здесь не было,
 * отмена не влияла на баланс ВООБЩЕ: бонус увеличивал долг, отмена его не уменьшала. У Насти так
 * набежало $50 лишнего долга из двух отменённых бонусов по $25.
 *
 * Направление читается у ВСЕХ типов, а не у части. Раньше BONUS складывался по сумме без оглядки
 * на direction — запись с DEBIT увеличивала бы долг вместо уменьшения. Сегодня все бонусы CREDIT,
 * то есть это была мина, а не поломка, но отличать её от настоящей ошибки в отчёте нечем.
 *
 * Отмена вычитается из ТОЙ ЖЕ корзины, что и запись, которую она отменяет: отмена бонуса
 * уменьшает бонусы, отмена ручной правки — правки. Складывать все отмены в «корректировки» было
 * ошибкой: отменив три бонуса на $112 при живой правке на $105, владелец видел «бонусы $112 и
 * корректировки −$7» — арифметически верно, а прочитать невозможно. Теперь это «корректировки
 * $105», а бонусы обнуляются и из строки исчезают. Итог по деньгам в обоих случаях один и тот же.
 */
async function recordedEntries(floristId: string) {
  const rows = await prisma.ledgerEntry.findMany({
    where: { floristId, type: { in: ["PAYMENT", "PAYMENT_REVERSAL", "BONUS", "MANUAL_ADJUSTMENT", "CORRECTION"] } },
    // Тип отменяемой записи — чтобы отмена попала в свою корзину, а не свалилась в «корректировки».
    select: { type: true, direction: true, amountCents: true, reversedEntry: { select: { type: true } } },
  });

  let paidCents = 0;
  let bonusCents = 0;
  let adjustmentCents = 0;
  const signed = (e: { direction: string; amountCents: number }) =>
    e.direction === "CREDIT" ? e.amountCents : -e.amountCents;

  for (const e of rows) {
    if (e.type === "PAYMENT") paidCents += e.amountCents;
    else if (e.type === "PAYMENT_REVERSAL") paidCents -= e.amountCents;
    // Отмена — это CORRECTION; в какую корзину она идёт, решает тип ОТМЕНЯЕМОЙ записи.
    else if ((e.reversedEntry?.type ?? e.type) === "BONUS") bonusCents += signed(e);
    else adjustmentCents += signed(e);
  }
  return { paidCents, bonusCents, adjustmentCents };
}

/**
 * Баланс одного флориста.
 *
 * Обёрнут в `cache()` — мемоизация НА ОДИН запрос React, не кеш между запросами. Кабинет
 * флориста спрашивает баланс дважды за рендер: карточкой «К выплате» на заработке и шапкой
 * ради остатка в форме выплаты. Без мемоизации это два прохода по дням и по книге ради
 * одного и того же числа; с ней — один. Значение внутри запроса и так обязано быть одним:
 * два разных ответа на «сколько должны» в одном экране — это баг, а не оптимизация.
 */
export const floristBalance = cache(_floristBalance);

async function _floristBalance(floristId: string, at: Date = new Date()): Promise<FloristBalance> {
  const profile = await prisma.floristFinanceProfile.findFirst({
    where: { floristId, active: true, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    select: { id: true, model: true, sharePercentBp: true },
  });

  const recorded = await recordedEntries(floristId);

  if (!profile) {
    return {
      floristId,
      model: null,
      earnedCents: 0,
      deductionCents: 0,
      ...recorded,
      outstandingCents: recorded.bonusCents - recorded.paidCents + recorded.adjustmentCents,
      detail: {},
    };
  }

  if (profile.model === "PRIMARY") {
    const earned = await primaryEarned(profile.id, profile.sharePercentBp);
    return {
      floristId,
      model: "PRIMARY",
      earnedCents: earned.cents,
      // Дополнительные расходы основного уже внутри прибыли дня — второй раз их вычитать
      // нельзя, иначе один расход ударит дважды.
      deductionCents: 0,
      ...recorded,
      outstandingCents: earned.cents + recorded.bonusCents - recorded.paidCents + recorded.adjustmentCents,
      detail: { days: earned.days },
    };
  }

  const earned = await secondaryEarned(floristId);
  return {
    floristId,
    model: "SECONDARY",
    earnedCents: earned.cents,
    deductionCents: earned.deductionCents,
    ...recorded,
    outstandingCents:
      earned.cents - earned.deductionCents + recorded.bonusCents - recorded.paidCents + recorded.adjustmentCents,
    detail: { orders: earned.orders },
  };
}

/**
 * Балансы нескольких флористов — для списка.
 *
 * Параллельно, а не в цикле с await: баланс каждого флориста — это три-четыре независимых
 * запроса, и последовательный обход превращал список из пяти человек в два десятка
 * round-trip'ов подряд. Между собой балансы не связаны, порядок ожидания не нужен.
 */
export async function floristBalances(floristIds: string[], at: Date = new Date()): Promise<Map<string, FloristBalance>> {
  const rows = await Promise.all(floristIds.map(async (id) => [id, await floristBalance(id, at)] as const));
  return new Map(rows);
}
