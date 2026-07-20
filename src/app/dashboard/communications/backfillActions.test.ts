import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/featureFlags", () => ({ featureFlags: { quo: true } }));
vi.mock("@/integrations/quo/config", () => ({ getQuoConfig: () => ({ apiKey: "k", baseUrl: "https://api.openphone.com/v1" }) }));
vi.mock("@/integrations/quo/client", () => ({ createQuoClient: vi.fn(() => ({})) }));
vi.mock("@/lib/rbac", () => ({ requireUser: vi.fn() }));
vi.mock("@/integrations/quo/backfill", () => ({ runBackfill: vi.fn(), BackfillConcurrentError: class extends Error {} }));
vi.mock("@/integrations/quo/communicationsService", () => ({ reprocessUnlinkedCommunications: vi.fn() }));

import { startBackfillAction, reprocessUnlinkedAction } from "./backfillActions";
import { requireUser } from "@/lib/rbac";
import { runBackfill } from "@/integrations/quo/backfill";
import { reprocessUnlinkedCommunications } from "@/integrations/quo/communicationsService";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("backfill actions — доступ и безопасность запуска", () => {
  beforeEach(() => vi.clearAllMocks());

  it("любой аутентифицированный сотрудник может запустить dry-run", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u_flo", role: "FLORIST" });
    (runBackfill as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "r1", mode: "DRY_RUN", counters: {}, breakdown: { byType: {}, bySite: {} }, sites: [] });
    const res = await startBackfillAction(null, fd({ mode: "DRY_RUN", days: "30" }));
    expect(res?.ok).toBe(true);
    expect(runBackfill).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ mode: "DRY_RUN", initiatedByUserId: "u_flo" }));
  });

  it("LIVE без confirm → отказ, реальный импорт не запускается", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "OWNER" });
    const res = await startBackfillAction(null, fd({ mode: "LIVE" }));
    expect(res?.error).toMatch(/подтвержд/i);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("неаутентифицированный не может запустить backfill (§8.12)", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startBackfillAction(null, fd({ mode: "DRY_RUN" }))).rejects.toThrow();
    await expect(reprocessUnlinkedAction()).rejects.toThrow();
    expect(runBackfill).not.toHaveBeenCalled();
    expect(reprocessUnlinkedCommunications).not.toHaveBeenCalled();
  });

  it("reprocess доступен аутентифицированному", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u2", role: "CALL_CENTER" });
    (reprocessUnlinkedCommunications as ReturnType<typeof vi.fn>).mockResolvedValue({ scanned: 3, linked: 2 });
    const res = await reprocessUnlinkedAction();
    expect(res).toMatchObject({ ok: true, relinked: 2 });
  });
});
