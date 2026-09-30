/**
 * Расписание флориста на день: кому сделать первым и когда каждый букет будет у клиента.
 *
 * Флорист собирает букеты по одному — это одна «линия». Курьеры у заказов свои и друг другу не
 * мешают. Очередь — по последнему моменту, когда букет ещё можно отдать курьеру (срок − курьер −
 * дорога): кому нужно раньше, того и делают первым. Это правило Джексона: оно даёт наименьшее
 * возможное максимальное опоздание на одной линии — ровно вопрос «не сорвать ни одного срока»
 * (research R4).
 *
 * Главный магазин (TheFlow) — первым в очереди, между собой — по сроку; заказы других магазинов —
 * после них (владелец 30.09.2026: «TheFlow всегда первые»). Кроме вечерних (окно с 17:00): они идут
 * после дневных заказов всех магазинов, а среди вечерних TheFlow снова первым («вечерние TheFlow
 * не надо пихать в начало очереди»). Опоздание других магазинов не мешает принять новый заказ.
 *
 * Плановая доставка = готовность + курьер + дорога, но не раньше начала окна: раньше букет просто
 * подождёт. Риск — доставка позже срока больше чем на допуск (20 минут, решение владельца).
 *
 * Чистый модуль: ни БД, ни «сейчас» — время начала линии передаётся параметром.
 */
import { LATE_TOLERANCE_MIN, EARLIEST_DELIVERY_MIN, EARLIEST_DELIVERY_AHEAD_MIN, EVENING_ORDER_MIN } from "./day";

export type PlanJob = {
  id: string;
  big: boolean;
  /** Крайний срок доставки: время клиента «до», иначе конец окна. */
  deadline: number;
  /** Раньше этого не везём (начало окна / «может с»). */
  windowFrom: number;
  driveMin: number;
  /** Букет уже готов, в пути или доставлен — в очередь сборки не входит. */
  fixed?: boolean;
  /** Заказ главного магазина: обязан успеть, остальные — в промежутки. */
  priority?: boolean;
};

export type PlanItem = PlanJob & {
  /** Место в очереди сборки (1…); у готовых — null. */
  seq: number | null;
  readyAt: number | null;
  etaAt: number | null;
  lateMin: number;
  risk: boolean;
};

export type Plan = { lineStart: number; items: PlanItem[] };

export type PlanParams = {
  /** Когда линия свободна для первого букета: начало работы + разгон, или «сейчас». */
  lineStart: number;
  courierMin: number;
  prepMin: (big: boolean) => number;
  /**
   * Заказ заранее: линию можно начать раньше, если иначе ранний заказ не успеть (владелец: «заранее
   * можем и супер рано»), но не раньше этого часа.
   */
  earliestLineStart?: number | null;
};

/** Последний момент, когда букет ещё можно отдать курьеру, чтобы успеть к сроку. */
function latestReady(j: PlanJob, courierMin: number): number {
  return j.deadline - courierMin - j.driveMin;
}

/** Вечерний заказ — окно с 17:00: собирать его первым незачем, букет только простоит. */
const isEvening = (j: PlanJob) => j.windowFrom >= EVENING_ORDER_MIN;

/**
 * Очередь: сначала дневные заказы, потом вечерние; внутри каждой части — TheFlow первым, дальше по
 * сроку. Так дневной TheFlow идёт раньше всех, а вечерний — после дневных заказов других магазинов.
 */
function order(jobs: PlanJob[], courierMin: number): PlanJob[] {
  return jobs
    .filter((j) => !j.fixed)
    .sort(
      (a, b) =>
        Number(isEvening(a)) - Number(isEvening(b)) ||
        Number(!!b.priority) - Number(!!a.priority) ||
        latestReady(a, courierMin) - latestReady(b, courierMin) ||
        a.windowFrom - b.windowFrom ||
        a.id.localeCompare(b.id)
    );
}

/** Опоздание каждого заказа очереди при сборке подряд с lineStart. */
function lateness(queue: PlanJob[], lineStart: number, p: PlanParams): number[] {
  let t = lineStart;
  return queue.map((j) => {
    t += p.prepMin(j.big);
    return Math.max(0, Math.max(t + p.courierMin + j.driveMin, j.windowFrom) - j.deadline);
  });
}

/**
 * TheFlow отпихивает остальных, когда иначе опоздает (владелец 30.09.2026: «если TheFlow, а мешают
 * заказы типа Paradise, — отпихивать Paradise и при необходимости ставить вперёд TheFlow»). Нужно
 * это вечерним заказам TheFlow: в очереди они после дневных заказов всех магазинов, и если тех
 * много, вечерний опоздал бы. Для каждого опаздывающего заказа TheFlow заказ другого магазина,
 * стоящий перед ним (с самым поздним сроком), уходит сразу за него — пока тот не успевает или
 * чужих перед ним не осталось. Перенос двигает чужой заказ только назад и заказы TheFlow ни на
 * минуту не задерживает; число «чужой перед TheFlow» с каждым шагом падает — цикл конечен.
 */
function rescuePriority(queue: PlanJob[], lineStart: number, p: PlanParams): PlanJob[] {
  const q = [...queue];
  for (;;) {
    const late = lateness(q, lineStart, p);
    let moved = false;
    for (let k = 0; k < q.length && !moved; k++) {
      if (!q[k].priority || late[k] <= LATE_TOLERANCE_MIN) continue;
      let move = -1;
      for (let i = 0; i < k; i++) {
        if (!q[i].priority && (move < 0 || latestReady(q[i], p.courierMin) >= latestReady(q[move], p.courierMin))) move = i;
      }
      // Перед ним только заказы TheFlow — этот не спасти перестановкой, смотрим следующий.
      if (move < 0) continue;
      const [j] = q.splice(move, 1);
      q.splice(k, 0, j); // опаздывающий сдвинулся на место k − 1: вставка на k — сразу за ним
      moved = true;
    }
    if (!moved) return q;
  }
}

export function planDay(jobs: PlanJob[], p: PlanParams): Plan {
  const byDeadline = order(jobs, p.courierMin);
  let lineStart = p.lineStart;
  if (p.earliestLineStart != null) {
    // Насколько раньше начать, чтобы самый срочный заказ успел: смотрим накопленную сборку.
    let acc = 0;
    let need = lineStart;
    for (const j of byDeadline) {
      acc += p.prepMin(j.big);
      need = Math.min(need, latestReady(j, p.courierMin) - acc);
    }
    lineStart = Math.max(p.earliestLineStart, Math.min(lineStart, need));
  }
  // Порядок частей дня (`order`), и опаздывающий TheFlow отпихивает остальных вперёд себя.
  const queue = rescuePriority(byDeadline, lineStart, p);

  const items: PlanItem[] = [];
  let t = lineStart;
  queue.forEach((j, i) => {
    t += p.prepMin(j.big);
    const etaAt = Math.max(t + p.courierMin + j.driveMin, j.windowFrom);
    const lateMin = Math.max(0, etaAt - j.deadline);
    items.push({ ...j, seq: i + 1, readyAt: t, etaAt, lateMin, risk: lateMin > LATE_TOLERANCE_MIN });
  });
  for (const j of jobs.filter((x) => x.fixed)) items.push({ ...j, seq: null, readyAt: null, etaAt: null, lateMin: 0, risk: false });
  return { lineStart, items };
}

/**
 * Влезет ли ещё один заказ: вставляем и смотрим, что стало с остальными. «Да» — если новый не в
 * риске и ни один из прежних заказов ГЛАВНОГО магазина не ушёл в риск и не стал позже, чем был,
 * сверх допуска. Опоздание других магазинов новый заказ не останавливает (владелец 29.09.2026).
 */
export function canFit(jobs: PlanJob[], job: PlanJob, p: PlanParams): { ok: boolean; etaAt: number | null } {
  const before = planDay(jobs, p);
  const after = planDay([...jobs.filter((j) => j.id !== job.id), job], p);
  const mine = after.items.find((i) => i.id === job.id)!;
  if (mine.risk) return { ok: false, etaAt: mine.etaAt };
  for (const a of after.items) {
    if (a.id === job.id || !a.priority) continue;
    const b = before.items.find((i) => i.id === a.id);
    const worse = a.lateMin > LATE_TOLERANCE_MIN && (!b || a.lateMin > b.lateMin);
    if (worse) return { ok: false, etaAt: mine.etaAt };
  }
  return { ok: true, etaAt: mine.etaAt };
}

/** Шаг перебора сроков — как шаг выбора времени (30 минут). */
const STEP = 30;
/** Позже этого сегодня не возим. */
const LAST_DEADLINE = 21 * 60;

/**
 * Самый ранний срок, к которому заказ влезает, не сломав остальных: перебор по получасу от начала
 * окна (или линии) до 21:00. null — сегодня не влезает вовсе.
 */
export function earliestBy(jobs: PlanJob[], job: Omit<PlanJob, "deadline">, p: PlanParams): number | null {
  // Заказ заранее может начаться раньше обычного начала линии (earliestLineStart).
  const start = p.earliestLineStart != null ? Math.min(p.lineStart, p.earliestLineStart) : p.lineStart;
  // Сегодня раньше 11:00 не обещаем, даже если собрать успеем раньше; заранее (earliestLineStart
  // есть только у будущего дня) — с 8:00, а сам ассистент раньше 11 называет, только если просят.
  const floor = p.earliestLineStart != null ? EARLIEST_DELIVERY_AHEAD_MIN : EARLIEST_DELIVERY_MIN;
  const first = Math.max(job.windowFrom, floor, start + p.prepMin(job.big) + p.courierMin + job.driveMin);
  const startAt = Math.ceil(first / STEP) * STEP;
  for (let d = startAt; d <= LAST_DEADLINE; d += STEP) {
    if (canFit(jobs, { ...job, deadline: d }, p).ok) return d;
  }
  return null;
}
