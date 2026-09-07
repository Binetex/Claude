import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Сигнал «кончились деньги» — не чаще раза в сутки: пустой баланс сам не чинится, а отказов за
 * это время наберётся десятки, и каждый из них не должен превращаться в сообщение владельцу.
 */
const sent: string[] = [];

vi.mock("@/integrations/telegram/bots", () => ({
  resolveOwnerBot: async () => ({ bot: { id: "b1", token: "tok", chatId: "chat", label: "Владелец" } }),
}));
vi.mock("@/integrations/telegram/config", () => ({
  isTelegramGloballyEnabled: async () => true,
  isTelegramAudienceOn: async () => true,
}));
vi.mock("@/integrations/telegram/sender", () => ({
  TelegramSender: class {
    async sendMessage(_chatId: string, text: string) {
      sent.push(text);
      return { ok: true };
    }
  },
}));

const { alertQuoOutOfMoney, __resetQuoBalanceAlert } = await import("./balanceAlert");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = {} as any;
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  sent.length = 0;
  __resetQuoBalanceAlert();
});

describe("alertQuoOutOfMoney", () => {
  it("первый отказ — сообщение владельцу, следующие за сутки молчат", async () => {
    await alertQuoOutOfMoney(prisma, at("2026-09-07T15:37:00Z"));
    await alertQuoOutOfMoney(prisma, at("2026-09-07T15:52:00Z"));
    await alertQuoOutOfMoney(prisma, at("2026-09-08T10:00:00Z"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("закончились деньги");
  });

  it("через сутки напоминаем ещё раз: баланс так и не пополнен", async () => {
    await alertQuoOutOfMoney(prisma, at("2026-09-07T15:37:00Z"));
    await alertQuoOutOfMoney(prisma, at("2026-09-08T16:00:00Z"));
    expect(sent).toHaveLength(2);
  });
});
