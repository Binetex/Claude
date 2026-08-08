/**
 * Отметка живости воркера.
 *
 * Зачем: единственный канал алертов очереди — Telegram при dead-letter, и отправляет его САМ
 * воркер. Умерший воркер ни на что не жалуется, а вместе с ним молча встают SMS, email,
 * создание доставок, fulfillment и пересчёт финансов — узнают об этом от клиента или флориста.
 * Отметку читает `/api/health/worker`, её опрашивает внешний монитор.
 *
 * Почему ФАЙЛ, а не таблица: воркер и Next.js — два процесса на одном VPS с общим рабочим
 * каталогом (`cwd: __dirname` в обоих ecosystem-конфигах), поэтому файла достаточно. Таблица
 * потребовала бы миграции и записи в БД каждые полминуты ради значения, которое не нужно
 * хранить дольше одной минуты. Каталог `logs/` есть на всех окружениях и деплоем не трогается
 * (git-ignored, кроме `.gitkeep`).
 *
 * Пишется НЕ каждый тик: тик идёт раз в секунду, а отметка нужна раз в полминуты — запись
 * троттлится (`MIN_WRITE_INTERVAL_MS`), иначе диску достанется 86 400 записей в сутки вместо 2 880.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type WorkerHeartbeat = {
  workerId: string;
  /** ISO-время последнего тика цикла воркера. */
  tickAt: string;
  pid: number;
};

/** Как часто отметка реально пишется на диск (цикл вызывает `beat` намного чаще). */
export const MIN_WRITE_INTERVAL_MS = 30_000;

/**
 * Возраст отметки, после которого воркер считается мёртвым. Заведомо больше интервала
 * записи (30 с) и паузы на `pm2 reload` при деплое — иначе каждый деплой давал бы ложную
 * тревогу.
 */
export const DEFAULT_MAX_AGE_MS = 120_000;

/** Путь к файлу отметки. Переопределяется `WORKER_HEARTBEAT_FILE` (нужно тестам и отладке). */
export function heartbeatFilePath(): string {
  return process.env.WORKER_HEARTBEAT_FILE ?? path.join(process.cwd(), "logs", "worker-heartbeat.json");
}

/** Устарела ли отметка. Чистая функция — вся арифметика решения здесь. */
export function isHeartbeatStale(tickAt: Date, now: Date, maxAgeMs: number = DEFAULT_MAX_AGE_MS): boolean {
  return now.getTime() - tickAt.getTime() > maxAgeMs;
}

/** Порог из окружения. Мусорное значение НЕ отключает проверку — берём дефолт. */
export function maxAgeMsFromEnv(raw: string | undefined = process.env.WORKER_HEARTBEAT_MAX_AGE_MS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_MS;
}

export type HeartbeatWriterOptions = {
  file?: string;
  minIntervalMs?: number;
  /** Инъекция для тестов. */
  writeFileFn?: (file: string, data: string) => Promise<void>;
};

/**
 * Пишущая сторона. `beat(now)` можно звать каждый цикл: писать чаще, чем раз в
 * `minIntervalMs`, она не будет.
 *
 * Ошибки записи ГЛОТАЕТ: отметка живости не имеет права ронять воркер — очередь важнее
 * сигнала о ней (то же правило, что у `notifyDeadLetter`). Неудачная запись просто состарит
 * отметку, и монитор об этом скажет.
 */
export function createHeartbeatWriter(opts: HeartbeatWriterOptions = {}) {
  const file = opts.file ?? heartbeatFilePath();
  const minIntervalMs = opts.minIntervalMs ?? MIN_WRITE_INTERVAL_MS;
  const write = opts.writeFileFn ?? atomicWrite;
  let lastWrittenMs: number | null = null;

  return {
    async beat(workerId: string, now: Date): Promise<void> {
      if (lastWrittenMs !== null && now.getTime() - lastWrittenMs < minIntervalMs) return;
      const payload: WorkerHeartbeat = { workerId, tickAt: now.toISOString(), pid: process.pid };
      try {
        await write(file, JSON.stringify(payload));
        lastWrittenMs = now.getTime();
      } catch (err) {
        console.error(`[outbox] отметка живости не записана (${file}):`, err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/**
 * Запись через временный файл и `rename`: читатель либо видит прежнюю отметку, либо новую
 * целиком. Без этого одновременное чтение могло поймать полуфайл, `JSON.parse` упал бы, и
 * живой воркер выглядел бы мёртвым.
 */
async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

/** Читающая сторона. `null` — отметки нет или она нечитаема (воркер ни разу не запускался). */
export async function readHeartbeat(file: string = heartbeatFilePath()): Promise<WorkerHeartbeat | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { workerId, tickAt, pid } = parsed as Partial<WorkerHeartbeat>;
    if (typeof workerId !== "string" || typeof tickAt !== "string") return null;
    if (Number.isNaN(Date.parse(tickAt))) return null;
    return { workerId, tickAt, pid: typeof pid === "number" ? pid : 0 };
  } catch {
    return null;
  }
}
