import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const sendOrderEmail = vi.fn();
vi.mock("@/integrations/emailFactory/send", () => ({ sendOrderEmail: (...a: unknown[]) => sendOrderEmail(...a) }));

import { createEmailFactoryChannelSender } from "./emailFactory";

const ctx = {
  prisma: {} as never, orderId: "o1", siteId: "s1", recipientType: "CUSTOMER" as const, phoneNormalized: null,
  emailNormalized: "a@b.c", triggerType: "ORDER_PAID", emailTemplateIdOverride: null, text: "Hi Jorge!", vars: {}, idempotencyKey: "j1:a0",
};

describe("письмо правила через наш почтовый модуль", () => {
  beforeEach(() => sendOrderEmail.mockReset());

  it("уходит заказчику текстом правила, без отправителя-человека, со своим ключом повтора", async () => {
    sendOrderEmail.mockResolvedValue({ ok: true, messageId: "m1" });
    const r = await createEmailFactoryChannelSender({} as never).send(ctx);
    expect(r).toEqual({ ok: true, providerMessageId: "m1" });
    // Адрес — тот, что выбрал движок, а не «последний, кто писал по заказу».
    expect(sendOrderEmail).toHaveBeenCalledWith({}, { orderId: "o1", text: "Hi Jorge!", sendKey: "auto:j1:a0", sentByUserId: null, toEmail: "a@b.c" });
  });

  it("без адреса заказчика — пропуск, а писать некому", async () => {
    expect(await createEmailFactoryChannelSender({} as never).send({ ...ctx, emailNormalized: null })).toEqual({ ok: false, code: "no_customer_email", retryable: false, skip: true });
    expect(sendOrderEmail).not.toHaveBeenCalled();
  });

  it("магазин без почтового домена или заказ без почты — пропуск, а не сбой", async () => {
    for (const code of ["domain_not_selected", "no_customer_email", "email_factory_not_configured"]) {
      sendOrderEmail.mockResolvedValue({ ok: false, code });
      expect(await createEmailFactoryChannelSender({} as never).send(ctx)).toEqual({ ok: false, code, retryable: false, skip: true });
    }
  });

  it("временный сбой — повторить, постоянный — ошибка", async () => {
    sendOrderEmail.mockResolvedValue({ ok: false, code: "ef_network", retryable: true });
    expect(await createEmailFactoryChannelSender({} as never).send(ctx)).toEqual({ ok: false, code: "ef_network", retryable: true, skip: false });
    sendOrderEmail.mockResolvedValue({ ok: false, code: "ef_bad_response" });
    expect(await createEmailFactoryChannelSender({} as never).send(ctx)).toEqual({ ok: false, code: "ef_bad_response", retryable: false, skip: false });
  });
});
