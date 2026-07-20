import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { order: { findMany: vi.fn() } } }));
vi.mock("@/lib/rbac", () => ({ requireUser: vi.fn() }));
vi.mock("@/integrations/quo/communicationsService", () => ({ linkCommunicationToOrder: vi.fn(), ignoreCommunication: vi.fn() }));

import { linkCommunicationAction, ignoreCommunicationAction } from "./actions";
import { requireUser } from "@/lib/rbac";
import { linkCommunicationToOrder, ignoreCommunication } from "@/integrations/quo/communicationsService";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("communications actions — доступ (любой аутентифицированный, не OWNER)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("link: аутентифицированный флорист может привязать по orderId", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "FLORIST" });
    (linkCommunicationToOrder as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const res = await linkCommunicationAction(null, fd({ communicationId: "c1", orderId: "o1" }));
    expect(res).toEqual({ ok: true });
    expect(linkCommunicationToOrder).toHaveBeenCalledWith(expect.anything(), "c1", "o1");
  });

  it("ignore: аутентифицированный колл-центр может игнорировать", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u2", role: "CALL_CENTER" });
    (ignoreCommunication as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const res = await ignoreCommunicationAction(null, fd({ communicationId: "c1" }));
    expect(res).toEqual({ ok: true });
    expect(ignoreCommunication).toHaveBeenCalledWith(expect.anything(), "c1");
  });

  it("неаутентифицированный (requireUser бросает) → действия не выполняются", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(linkCommunicationAction(null, fd({ communicationId: "c1", orderId: "o1" }))).rejects.toThrow();
    await expect(ignoreCommunicationAction(null, fd({ communicationId: "c1" }))).rejects.toThrow();
    expect(linkCommunicationToOrder).not.toHaveBeenCalled();
    expect(ignoreCommunication).not.toHaveBeenCalled();
  });
});
