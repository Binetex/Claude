import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET } from "./route";
import { createHeartbeatWriter } from "@/outbox/heartbeat";

/**
 * Проверяется именно КОД ОТВЕТА: на него смотрит внешний монитор, и подмена 503 на 200
 * сделала бы всю затею бессмысленной, ничего не сломав в интерфейсе.
 */
describe("GET /api/health/worker", () => {
  let file: string;
  const saved = { file: process.env.WORKER_HEARTBEAT_FILE, maxAge: process.env.WORKER_HEARTBEAT_MAX_AGE_MS };

  beforeEach(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fm-hb-route-"));
    file = path.join(dir, "worker-heartbeat.json");
    process.env.WORKER_HEARTBEAT_FILE = file;
    delete process.env.WORKER_HEARTBEAT_MAX_AGE_MS;
  });

  afterEach(() => {
    if (saved.file === undefined) delete process.env.WORKER_HEARTBEAT_FILE;
    else process.env.WORKER_HEARTBEAT_FILE = saved.file;
    if (saved.maxAge === undefined) delete process.env.WORKER_HEARTBEAT_MAX_AGE_MS;
    else process.env.WORKER_HEARTBEAT_MAX_AGE_MS = saved.maxAge;
  });

  it("отметки нет → 503 no_heartbeat", async () => {
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: "error", worker: "no_heartbeat" });
  });

  it("свежая отметка → 200 alive с id воркера", async () => {
    await createHeartbeatWriter({ file }).beat("worker-77", new Date());

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", worker: "alive", workerId: "worker-77" });
    expect(body.ageMs).toBeLessThan(5_000);
  });

  it("старая отметка → 503 stale (воркер не тикает)", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await createHeartbeatWriter({ file }).beat("worker-77", old);

    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ status: "error", worker: "stale", workerId: "worker-77" });
  });

  it("порог настраивается: с большим окном та же отметка живая", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await createHeartbeatWriter({ file }).beat("worker-77", old);
    process.env.WORKER_HEARTBEAT_MAX_AGE_MS = String(60 * 60_000);

    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("битый файл → 503, а не исключение", async () => {
    await writeFile(file, "{неполный", "utf8");

    const res = await GET();
    expect(res.status).toBe(503);
  });
});
