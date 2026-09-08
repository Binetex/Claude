import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findMany: vi.fn(), findUnique: vi.fn() },
    orderCommunication: { findFirst: vi.fn() },
    site: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/rbac", () => ({ requireUser: vi.fn() }));
vi.mock("@/integrations/quo/communicationsService", () => ({ linkThreadToOrder: vi.fn(), setThreadTopic: vi.fn(), loadQuoNumberOwners: vi.fn() }));
vi.mock("@/modules/assistant/prompt", () => ({ looksEnglish: (t: string) => !/[\u0400-\u04FF]/.test(t) }));
vi.mock("@/integrations/quo/config", () => ({ getQuoConfig: () => ({ apiKey: "k" }) }));
vi.mock("@/integrations/quo/client", () => ({ createQuoClient: () => ({}) }));
vi.mock("@/lib/featureFlags", () => ({ featureFlags: { quo: true } }));
vi.mock("@/integrations/quo/send", () => ({ sendUnlinkedSms: vi.fn() }));

import { linkThreadAction, sendThreadSmsAction, setThreadTopicAction } from "./actions";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { linkThreadToOrder, setThreadTopic, loadQuoNumberOwners } from "@/integrations/quo/communicationsService";
import { sendUnlinkedSms } from "@/integrations/quo/send";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe("«Другие сообщения» — действия", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock(requireUser).mockResolvedValue({ id: "u1", role: "CALL_CENTER" });
  });

  it("привязка уносит в заказ ВСЮ переписку по паре номер+магазин", async () => {
    mock(linkThreadToOrder).mockResolvedValue({ ok: true, linked: 8 });
    const res = await linkThreadAction(null, fd({ phone: "+13105550101", pn: "PN1", orderId: "o1" }));
    expect(res).toEqual({ ok: true });
    expect(linkThreadToOrder).toHaveBeenCalledWith(expect.anything(), {
      phoneE164: "+13105550101", providerPhoneNumberId: "PN1", orderId: "o1",
    });
  });

  it("привязывать нечего — говорим об этом, а не рапортуем об успехе", async () => {
    mock(linkThreadToOrder).mockResolvedValue({ ok: true, linked: 0 });
    const res = await linkThreadAction(null, fd({ phone: "+13105550101", pn: "PN1", orderId: "o1" }));
    expect(res?.error).toBeTruthy();
  });

  it("ОТПРАВКА: магазин определяет сервер по номеру переписки, siteId из формы игнорируется", async () => {
    mock(prisma.orderCommunication.findFirst).mockResolvedValue({ id: "c1" });
    mock(loadQuoNumberOwners).mockResolvedValue(new Map([["PN1", { siteId: "site-real", name: "TheFlow", shortName: null, quoPhoneNumber: "+13238008421", isPrimary: true }]]));
    mock(sendUnlinkedSms).mockResolvedValue({ ok: true, status: "SENT" });

    const res = await sendThreadSmsAction(null, fd({
      phone: "+13105550101", pn: "PN1", text: "hi", idempotencyKey: "k1",
      siteId: "site-подменённый-из-браузера",
    }));

    expect(res).toEqual({ ok: true });
    expect(sendUnlinkedSms).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      siteId: "site-real", toPhone: "+13105550101", sentByUserId: "u1",
      // Ответ уходит С ТОГО ЖЕ номера, на который написал человек.
      fromPhoneNumberId: "PN1",
    }));
  });

  it("ОТПРАВКА: работает и со ВТОРОГО номера магазина — ответ уйдёт с него же", async () => {
    mock(prisma.orderCommunication.findFirst).mockResolvedValue({ id: "c1" });
    mock(loadQuoNumberOwners).mockResolvedValue(new Map([["PNsecond", { siteId: "site-theflow", name: "TheFlow", shortName: null, quoPhoneNumber: "+13238004481", isPrimary: false }]]));
    mock(sendUnlinkedSms).mockResolvedValue({ ok: true, status: "SENT" });

    const res = await sendThreadSmsAction(null, fd({ phone: "+13105550101", pn: "PNsecond", text: "hi", idempotencyKey: "k9" }));
    expect(res).toEqual({ ok: true });
    expect(sendUnlinkedSms).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      siteId: "site-theflow", fromPhoneNumberId: "PNsecond",
    }));
  });

  it("ОТПРАВКА: нет такой переписки — не отправляем вовсе", async () => {
    mock(prisma.orderCommunication.findFirst).mockResolvedValue(null);
    const res = await sendThreadSmsAction(null, fd({ phone: "+19998887766", pn: "PN1", text: "hi", idempotencyKey: "k2" }));
    expect(res?.error).toBeTruthy();
    expect(sendUnlinkedSms).not.toHaveBeenCalled();
  });

  it("ОТПРАВКА: QUO-номер не привязан к магазину — не отправляем", async () => {
    mock(prisma.orderCommunication.findFirst).mockResolvedValue({ id: "c1" });
    mock(loadQuoNumberOwners).mockResolvedValue(new Map());
    const res = await sendThreadSmsAction(null, fd({ phone: "+13105550101", pn: "PNunknown", text: "hi", idempotencyKey: "k3" }));
    expect(res?.error).toBeTruthy();
    expect(sendUnlinkedSms).not.toHaveBeenCalled();
  });

  it("ОТПРАВКА: русский текст клиенту не уходит", async () => {
    mock(prisma.orderCommunication.findFirst).mockResolvedValue({ id: "c1" });
    mock(loadQuoNumberOwners).mockResolvedValue(new Map([["PN1", { siteId: "s1", name: "S", shortName: null, quoPhoneNumber: null, isPrimary: true }]]));
    const res = await sendThreadSmsAction(null, fd({ phone: "+13105550101", pn: "PN1", text: "Да, приезжайте, мы до 19:00", idempotencyKey: "kru" }));
    expect(res?.error).toContain("английск");
    expect(sendUnlinkedSms).not.toHaveBeenCalled();
  });

  it("ОТПРАВКА: отказ провайдера переводится человеческим текстом", async () => {
    mock(prisma.orderCommunication.findFirst).mockResolvedValue({ id: "c1" });
    mock(loadQuoNumberOwners).mockResolvedValue(new Map([["PN1", { siteId: "s1", name: "S", shortName: null, quoPhoneNumber: null, isPrimary: true }]]));
    mock(sendUnlinkedSms).mockResolvedValue({ ok: false, code: "quo_client", detail: "402" });
    const res = await sendThreadSmsAction(null, fd({ phone: "+13105550101", pn: "PN1", text: "hi", idempotencyKey: "k4" }));
    expect(res?.error).toContain("деньги");
  });

  it("категория: неизвестный ключ отклоняется, пустая строка снимает ручную метку", async () => {
    mock(setThreadTopic).mockResolvedValue(1);
    expect((await setThreadTopicAction(null, fd({ phone: "+1", pn: "PN1", topic: "ЧУШЬ" })))?.error).toBeTruthy();
    expect(setThreadTopic).not.toHaveBeenCalled();

    await setThreadTopicAction(null, fd({ phone: "+1", pn: "PN1", topic: "" }));
    expect(setThreadTopic).toHaveBeenCalledWith(expect.anything(), { phoneE164: "+1", providerPhoneNumberId: "PN1", topic: null });
  });

  it("неаутентифицированный — ни одно действие не выполняется", async () => {
    mock(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(linkThreadAction(null, fd({ phone: "+1", pn: "PN1", orderId: "o1" }))).rejects.toThrow();
    await expect(sendThreadSmsAction(null, fd({ phone: "+1", pn: "PN1", text: "x", idempotencyKey: "k" }))).rejects.toThrow();
    expect(linkThreadToOrder).not.toHaveBeenCalled();
    expect(sendUnlinkedSms).not.toHaveBeenCalled();
  });
});
