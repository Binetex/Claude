/**
 * Модель времени доставки: сколько длится каждый этап — по фактическим доставкам.
 *
 * Этапы: сборка букета у флориста (по размеру, у каждого флориста своя), ожидание курьера (от
 * вызова до «забрал»), дорога (по расстоянию от места флориста до адреса). Плюс «разгон» — сколько
 * от начала рабочего дня проходит до первого готового букета сверх обычной сборки.
 *
 * Цифры считаются по доставкам Burq за 60 дней (stats.ts) и сами обновляются. Когда данных мало —
 * стартовые значения замера 28.09.2026 (414 доставок). Статистики (research R2):
 *  - курьер и дорога — 80-й перцентиль: это одиночные слагаемые обещания, нужен запас;
 *  - сборка — медиана: сборки в очереди суммируются, сумма 80-х перцентилей завышала бы загрузку.
 *
 * Чистый модуль: ни БД, ни «сейчас».
 */

export type DriveBucket = { fromMiles: number; toMiles: number; min: number };

export type TimeModel = {
  /** Ожидание курьера: от вызова до «забрал букет», 80-й перцентиль. */
  courierMin: number;
  /** Дорога по корзинам расстояния (миля по прямой между центрами индексов), 80-й перцентиль. */
  drive: DriveBucket[];
  /** Дорога, когда адрес или место флориста неизвестны. */
  unknownDriveMin: number;
  /** Сборка по флористам: медиана интервала между вызовами курьеров. */
  prep: Record<string, { small: number; big: number }>;
  prepDefault: { small: number; big: number };
  /** «Разгон» дня по флористам: сколько сверх обычной сборки до первого готового букета. */
  setup: Record<string, number>;
  setupDefault: number;
  sample: { deliveries: number; since: string | null; computedAt: string | null; measured: boolean };
};

/** Корзины расстояния и стартовые значения дороги (p80, замер 28.09.2026). */
const DEFAULT_DRIVE: DriveBucket[] = [
  { fromMiles: 0, toMiles: 3, min: 28 },
  { fromMiles: 3, toMiles: 6, min: 51 },
  { fromMiles: 6, toMiles: 10, min: 63 },
  { fromMiles: 10, toMiles: 15, min: 71 },
  { fromMiles: 15, toMiles: 25, min: 90 },
  { fromMiles: 25, toMiles: 60, min: 110 },
];

/** Стартовые значения — замер по продовым доставкам 28.09.2026. */
export const DEFAULT_MODEL: TimeModel = {
  courierMin: 24,
  drive: DEFAULT_DRIVE,
  unknownDriveMin: 63,
  prep: {},
  prepDefault: { small: 45, big: 64 },
  setup: {},
  setupDefault: 60,
  sample: { deliveries: 0, since: null, computedAt: null, measured: false },
};

/** Меньше этого — статистике не верим, берём стартовое значение. */
const MIN_SAMPLES = 20;
const MIN_BUCKET_SAMPLES = 8;
const MIN_PREP_SAMPLES = 10;
const MIN_DAYS_FOR_SETUP = 8;
/** Дольше этого дороги не бывает в нашем районе: дальше — решает человек. */
export const MAX_DRIVE_MIN = 150;

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Одна доставка для статистики: расстояние, ожидание курьера, дорога (минуты). */
export type DeliverySample = { miles: number | null; waitMin: number | null; driveMin: number | null };
/** Интервал между двумя вызовами курьера у флориста в один день — сборка следующего букета. */
export type PrepSample = { floristId: string; big: boolean; min: number };
/** Первый вызов курьера в день, когда у флориста было 2+ утренних заказа. */
export type FirstDispatchSample = { floristId: string; min: number };

export function computeModel(input: {
  deliveries: DeliverySample[];
  prep: PrepSample[];
  firstDispatch: FirstDispatchSample[];
  workStart: Record<string, number | null>;
  since: string;
  computedAt: string;
}): TimeModel {
  const waits = input.deliveries.map((d) => d.waitMin).filter((v): v is number => v != null && v > 0 && v < 300);
  const courierMin = waits.length >= MIN_SAMPLES ? Math.round(percentile(waits, 0.8)!) : DEFAULT_MODEL.courierMin;

  const withDrive = input.deliveries.filter((d): d is DeliverySample & { driveMin: number } => d.driveMin != null && d.driveMin > 0 && d.driveMin < 240);
  const drive = DEFAULT_DRIVE.map((b) => {
    const inBucket = withDrive.filter((d) => d.miles != null && d.miles >= b.fromMiles && d.miles < b.toMiles).map((d) => d.driveMin);
    return inBucket.length >= MIN_BUCKET_SAMPLES ? { ...b, min: Math.round(percentile(inBucket, 0.8)!) } : b;
  });
  // Дорога не может становиться короче с расстоянием: выравниваем корзины, если выборка шумит.
  for (let i = 1; i < drive.length; i++) if (drive[i].min < drive[i - 1].min) drive[i] = { ...drive[i], min: drive[i - 1].min };
  const allDrives = withDrive.map((d) => d.driveMin);
  const unknownDriveMin = allDrives.length >= MIN_SAMPLES ? Math.round(percentile(allDrives, 0.8)!) : DEFAULT_MODEL.unknownDriveMin;

  const prep: TimeModel["prep"] = {};
  const florists = new Set(input.prep.map((p) => p.floristId));
  for (const id of florists) {
    const mine = input.prep.filter((p) => p.floristId === id && p.min >= 10 && p.min <= 180);
    const small = mine.filter((p) => !p.big).map((p) => p.min);
    const big = mine.filter((p) => p.big).map((p) => p.min);
    const s = small.length >= MIN_PREP_SAMPLES ? clamp(Math.round(percentile(small, 0.5)!), 20, 150) : DEFAULT_MODEL.prepDefault.small;
    // Больших букетов мало: без выборки — маленький плюс обычная разница.
    const bigDefault = s + (DEFAULT_MODEL.prepDefault.big - DEFAULT_MODEL.prepDefault.small);
    const b = big.length >= MIN_PREP_SAMPLES ? clamp(Math.round(percentile(big, 0.5)!), s, 180) : bigDefault;
    prep[id] = { small: s, big: Math.max(b, s) };
  }

  const setup: TimeModel["setup"] = {};
  const byFlorist = new Map<string, number[]>();
  for (const f of input.firstDispatch) (byFlorist.get(f.floristId) ?? byFlorist.set(f.floristId, []).get(f.floristId)!).push(f.min);
  for (const [id, firsts] of byFlorist) {
    if (firsts.length < MIN_DAYS_FOR_SETUP) continue;
    const start = input.workStart[id] ?? DEFAULT_WORK_START_MIN;
    const small = prep[id]?.small ?? DEFAULT_MODEL.prepDefault.small;
    setup[id] = clamp(Math.round(percentile(firsts, 0.5)! - start - small), 0, 150);
  }

  return {
    courierMin,
    drive,
    unknownDriveMin,
    prep,
    prepDefault: DEFAULT_MODEL.prepDefault,
    setup,
    setupDefault: DEFAULT_MODEL.setupDefault,
    sample: { deliveries: input.deliveries.length, since: input.since, computedAt: input.computedAt, measured: input.deliveries.length >= MIN_SAMPLES },
  };
}

/** Начало работы флориста, если не задано в карточке. */
export const DEFAULT_WORK_START_MIN = 10 * 60;

/**
 * Дорога на это расстояние: линейно между серединами корзин, за последней — с тем же наклоном.
 * Расстояние неизвестно — «средняя» дорога.
 */
export function driveMin(model: TimeModel, miles: number | null | undefined): number {
  if (miles == null || !Number.isFinite(miles)) return model.unknownDriveMin;
  const pts = model.drive.map((b) => ({ x: (b.fromMiles + b.toMiles) / 2, y: b.min }));
  if (miles <= pts[0].x) return pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    if (miles <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      return Math.round(a.y + ((b.y - a.y) * (miles - a.x)) / (b.x - a.x));
    }
  }
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const slope = (b.y - a.y) / (b.x - a.x);
  return Math.min(MAX_DRIVE_MIN, Math.round(b.y + slope * (miles - b.x)));
}

export function prepMin(model: TimeModel, floristId: string | null | undefined, big: boolean): number {
  const p = (floristId && model.prep[floristId]) || model.prepDefault;
  return big ? p.big : p.small;
}

export function setupMin(model: TimeModel, floristId: string | null | undefined): number {
  return floristId && model.setup[floristId] != null ? model.setup[floristId] : model.setupDefault;
}
