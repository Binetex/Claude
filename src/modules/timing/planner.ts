/**
 * Расписание флориста на день: кому сделать первым и когда каждый букет будет у клиента.
 *
 * Флорист собирает букеты по одному — это одна «линия». Курьеры у заказов свои и друг другу не
 * мешают. Очередь — по последнему моменту, когда букет ещё можно отдать курьеру (срок − курьер −
 * дорога): кому нужно раньше, того и делают первым. Это правило Джексона: оно даёт наименьшее
 * возможное максимальное опоздание на одной линии — ровно вопрос «не сорвать ни одного срока»
 * (research R4).
 *
 * Плановая доставка = готовность + курьер + дорога, но не раньше начала окна: раньше букет просто
 * подождёт. Риск — доставка позже срока больше чем на допуск (20 минут, решение владельца).
 *
 * Чистый модуль: ни БД, ни «сейчас» — время начала линии передаётся параметром.
 */
import { LATE_TOLERANCE_MIN } from "./day";

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

function order(jobs: PlanJob[], courierMin: number): PlanJob[] {
  return jobs
    .filter((j) => !j.fixed)
    .sort((a, b) => latestReady(a, courierMin) - latestReady(b, courierMin) || a.windowFrom - b.windowFrom || a.id.localeCompare(b.id));
}

export function planDay(jobs: PlanJob[], p: PlanParams): Plan {
  const queue = order(jobs, p.courierMin);
  let lineStart = p.lineStart;
  if (p.earliestLineStart != null) {
    // Насколько раньше начать, чтобы самый срочный заказ успел: смотрим накопленную сборку.
    let acc = 0;
    let need = lineStart;
    for (const j of queue) {
      acc += p.prepMin(j.big);
      need = Math.min(need, latestReady(j, p.courierMin) - acc);
    }
    lineStart = Math.max(p.earliestLineStart, Math.min(lineStart, need));
  }

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
 * риске и ни один из прежних не ушёл в риск и не стал позже, чем был, сверх допуска.
 */
export function canFit(jobs: PlanJob[], job: PlanJob, p: PlanParams): { ok: boolean; etaAt: number | null } {
  const before = planDay(jobs, p);
  const after = planDay([...jobs.filter((j) => j.id !== job.id), job], p);
  const mine = after.items.find((i) => i.id === job.id)!;
  if (mine.risk) return { ok: false, etaAt: mine.etaAt };
  for (const a of after.items) {
    if (a.id === job.id) continue;
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
  const first = Math.max(job.windowFrom, start + p.prepMin(job.big) + p.courierMin + job.driveMin);
  const startAt = Math.ceil(first / STEP) * STEP;
  for (let d = startAt; d <= LAST_DEADLINE; d += STEP) {
    if (canFit(jobs, { ...job, deadline: d }, p).ok) return d;
  }
  return null;
}
