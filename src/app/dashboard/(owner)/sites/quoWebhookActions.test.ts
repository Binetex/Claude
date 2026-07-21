import { describe, it, expect, vi, beforeEach } from "vitest";

/** Owner-only guard + аудит без значения секрета (мок-слой). */

const requireRole = vi.fn();
const addSvc = vi.fn();
const removeSvc = vi.fn();

vi.mock("@/lib/rbac", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/integrations/quo/signingSecrets", () => ({
  addQuoSigningSecret: (...a: unknown[]) => addSvc(...a),
  removeQuoSigningSecret: (...a: unknown[]) => removeSvc(...a),
  countActiveQuoSigningSecrets: vi.fn(async () => 0),
  getActiveQuoSigningSecrets: vi.fn(async () => [] as string[]),
}));
vi.mock("@/integrations/quo/config", () => ({ getQuoSigningKeys: () => [] as string[] }));
vi.mock("@/lib/crypto/secretBox", () => ({ isCredentialCryptoConfigured: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ownerAddQuoSigningSecret, ownerRemoveQuoSigningSecret } from "./quoWebhookActions";

beforeEach(() => {
  requireRole.mockReset(); requireRole.mockResolvedValue({ id: "u-owner", role: "OWNER" });
  addSvc.mockReset(); removeSvc.mockReset();
});

describe("quoWebhookActions — owner-only + аудит без значения", () => {
  it("owner добавляет: requireRole(OWNER), сервис вызван, аудит содержит маску, но НЕ секрет", async () => {
    addSvc.mockResolvedValue({ ok: true, id: "s1", maskedSuffix: "********abcd" });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await ownerAddQuoSigningSecret("super-secret-value-xyz");
    expect(r).toEqual({ ok: true });
    expect(requireRole).toHaveBeenCalledWith("OWNER");
    expect(addSvc).toHaveBeenCalledWith({}, "super-secret-value-xyz");
    const logged = spy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain("added");
    expect(logged).toContain("********abcd");
    expect(logged).not.toContain("super-secret-value-xyz"); // значение не в аудите
    spy.mockRestore();
  });

  it("не-owner: requireRole редиректит (throw) → сервис НЕ вызывается", async () => {
    requireRole.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(ownerAddQuoSigningSecret("x")).rejects.toThrow();
    expect(addSvc).not.toHaveBeenCalled();
  });

  it("remove: owner-only + аудит removed (маска, без значения)", async () => {
    removeSvc.mockResolvedValue({ ok: true, maskedSuffix: "********wxyz" });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await ownerRemoveQuoSigningSecret("s1");
    expect(r).toEqual({ ok: true });
    expect(requireRole).toHaveBeenCalledWith("OWNER");
    const logged = spy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain("removed");
    expect(logged).toContain("********wxyz");
    spy.mockRestore();
  });
});
