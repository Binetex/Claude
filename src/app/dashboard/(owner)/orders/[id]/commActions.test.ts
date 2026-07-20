import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/featureFlags", () => ({ featureFlags: { quo: false } }));
vi.mock("@/integrations/quo/config", () => ({ getQuoConfig: () => null }));
vi.mock("@/integrations/quo/client", () => ({ createQuoClient: vi.fn() }));
vi.mock("@/lib/rbac", () => ({ requireUser: vi.fn() }));
vi.mock("@/integrations/quo/send", () => ({ sendOrderSms: vi.fn() }));

import { sendOrderSmsAction } from "./commActions";
import { requireUser } from "@/lib/rbac";
import { sendOrderSms } from "@/integrations/quo/send";

function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base = { orderId: "o1", target: "CUSTOMER", text: "hello", idempotencyKey: "key-1", ...over };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
}

describe("sendOrderSmsAction — доступ", () => {
  beforeEach(() => vi.clearAllMocks());

  it("любой аутентифицированный сотрудник (не OWNER) может отправить; сохраняется его id", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u_flo", role: "FLORIST" });
    (sendOrderSms as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: "SENT", communicationId: "c1", duplicate: false });
    const res = await sendOrderSmsAction(null, fd());
    expect(res).toMatchObject({ ok: true, status: "SENT" });
    expect(sendOrderSms).toHaveBeenCalledWith(expect.anything(), null /* quo not configured in test */, expect.objectContaining({ orderId: "o1", target: "CUSTOMER", sentByUserId: "u_flo" }));
  });

  it("неаутентифицированный (requireUser редиректит/бросает) → действие не выполняется", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(sendOrderSmsAction(null, fd())).rejects.toThrow();
    expect(sendOrderSms).not.toHaveBeenCalled();
  });

  it("некорректный target → ошибка запроса, без отправки", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "OWNER" });
    const res = await sendOrderSmsAction(null, fd({ target: "BOGUS" }));
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(sendOrderSms).not.toHaveBeenCalled();
  });

  it("ошибку сервиса пробрасывает как понятное сообщение", async () => {
    (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u1", role: "CALL_CENTER" });
    (sendOrderSms as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, code: "store_no_quo_number" });
    const res = await sendOrderSmsAction(null, fd());
    expect(res?.error).toMatch(/QUO/);
  });
});
