import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHeartbeatWriter,
  isHeartbeatStale,
  maxAgeMsFromEnv,
  readHeartbeat,
  DEFAULT_MAX_AGE_MS,
  MIN_WRITE_INTERVAL_MS,
} from "./heartbeat";

const T0 = new Date("2026-08-08T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("isHeartbeatStale", () => {
  it("свежая отметка живая", () => {
    expect(isHeartbeatStale(T0, at(30_000))).toBe(false);
  });

  it("на самой границе окна ещё живая — тревога только ПОСЛЕ порога", () => {
    expect(isHeartbeatStale(T0, at(DEFAULT_MAX_AGE_MS))).toBe(false);
    expect(isHeartbeatStale(T0, at(DEFAULT_MAX_AGE_MS + 1))).toBe(true);
  });

  it("порог заведомо больше интервала записи — иначе тревога на каждой второй записи", () => {
    expect(DEFAULT_MAX_AGE_MS).toBeGreaterThan(MIN_WRITE_INTERVAL_MS * 2);
  });
});

describe("maxAgeMsFromEnv", () => {
  it("берёт число из окружения", () => {
    expect(maxAgeMsFromEnv("300000")).toBe(300_000);
  });

  it("мусор и ноль НЕ отключают проверку — дефолт", () => {
    expect(maxAgeMsFromEnv(undefined)).toBe(DEFAULT_MAX_AGE_MS);
    expect(maxAgeMsFromEnv("")).toBe(DEFAULT_MAX_AGE_MS);
    expect(maxAgeMsFromEnv("нет")).toBe(DEFAULT_MAX_AGE_MS);
    expect(maxAgeMsFromEnv("0")).toBe(DEFAULT_MAX_AGE_MS);
    expect(maxAgeMsFromEnv("-5")).toBe(DEFAULT_MAX_AGE_MS);
  });
});

describe("createHeartbeatWriter (троттлинг)", () => {
  function fakeWriter() {
    const writes: string[] = [];
    const w = createHeartbeatWriter({
      file: "/dev/null/heartbeat.json",
      writeFileFn: async (_file, data) => {
        writes.push(data);
      },
    });
    return { w, writes };
  }

  it("первый вызов пишет, следующие внутри интервала — нет", async () => {
    const { w, writes } = fakeWriter();
    await w.beat("worker-1", T0);
    await w.beat("worker-1", at(1_000));
    await w.beat("worker-1", at(29_999));
    expect(writes).toHaveLength(1);
  });

  it("после интервала пишет снова", async () => {
    const { w, writes } = fakeWriter();
    await w.beat("worker-1", T0);
    await w.beat("worker-1", at(MIN_WRITE_INTERVAL_MS));
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]).tickAt).toBe(at(MIN_WRITE_INTERVAL_MS).toISOString());
  });

  it("ошибка записи НЕ пробрасывается — очередь важнее отметки о ней", async () => {
    const w = createHeartbeatWriter({
      file: "/nope/heartbeat.json",
      writeFileFn: async () => {
        throw new Error("EACCES");
      },
    });
    await expect(w.beat("worker-1", T0)).resolves.toBeUndefined();
  });

  it("неудачная запись не считается сделанной — следующий вызов пробует снова", async () => {
    let fail = true;
    const writes: string[] = [];
    const w = createHeartbeatWriter({
      file: "/tmp/heartbeat.json",
      writeFileFn: async (_f, data) => {
        if (fail) throw new Error("EACCES");
        writes.push(data);
      },
    });
    await w.beat("worker-1", T0);
    fail = false;
    await w.beat("worker-1", at(1_000)); // внутри интервала, но прошлая запись не удалась
    expect(writes).toHaveLength(1);
  });
});

describe("readHeartbeat", () => {
  it("читает то, что записал writer (реальный файл)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fm-heartbeat-"));
    const file = path.join(dir, "worker-heartbeat.json");
    const w = createHeartbeatWriter({ file });

    await w.beat("worker-42", T0);

    const beat = await readHeartbeat(file);
    expect(beat?.workerId).toBe("worker-42");
    expect(beat?.tickAt).toBe(T0.toISOString());
    expect(isHeartbeatStale(new Date(beat!.tickAt), at(10_000))).toBe(false);
  });

  it("нет файла → null (воркер ни разу не запускался)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fm-heartbeat-"));
    expect(await readHeartbeat(path.join(dir, "нет-такого.json"))).toBeNull();
  });

  it("битый или чужой JSON → null, а не исключение в эндпоинте", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fm-heartbeat-"));
    const broken = path.join(dir, "broken.json");
    await writeFile(broken, "{неполный", "utf8");
    expect(await readHeartbeat(broken)).toBeNull();

    const alien = path.join(dir, "alien.json");
    await writeFile(alien, JSON.stringify({ workerId: "w", tickAt: "не дата" }), "utf8");
    expect(await readHeartbeat(alien)).toBeNull();
  });

  it("временный файл не остаётся вместо основного (запись через rename)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fm-heartbeat-"));
    const file = path.join(dir, "worker-heartbeat.json");
    await createHeartbeatWriter({ file }).beat("worker-1", T0);
    await expect(readFile(`${file}.tmp`, "utf8")).rejects.toThrow();
  });
});
