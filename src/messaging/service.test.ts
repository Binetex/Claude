import { describe, it, expect } from "vitest";
import { MessagingService } from "./service";
import { MockMessageProvider, createMockProviders } from "./providers/mock";
import { renderMessage } from "./templates";
import { IntegrationError } from "@/integrations/errors";
import type { MessageCommand } from "./types";

const cmd = (over: Partial<MessageCommand> = {}): MessageCommand => ({
  channel: "SMS",
  to: "+15551112222",
  templateId: "order.delivery.completed",
  vars: { orderNumber: "O-1053" },
  idempotencyKey: "o1:sms",
  ...over,
});

describe("MessagingService.send", () => {
  it("отправляет через провайдер канала и рендерит шаблон", async () => {
    const providers = createMockProviders();
    const svc = new MessagingService().register(providers.SMS);
    const res = await svc.send(cmd());
    expect(res.status).toBe("sent");
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.SMS.sent[0].message.body).toContain("O-1053");
  });

  it("идемпотентна: повтор того же ключа не шлёт дубль", async () => {
    const providers = createMockProviders();
    const svc = new MessagingService().register(providers.SMS);
    await svc.send(cmd());
    const second = await svc.send(cmd());
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("duplicate");
    expect(providers.SMS.sent).toHaveLength(1);
  });

  it("skipped, если нет провайдера для канала", async () => {
    const svc = new MessagingService(); // ничего не зарегистрировано
    const res = await svc.send(cmd({ channel: "PUSH", idempotencyKey: "k-push" }));
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("no_provider");
  });

  it("failed с retryable по классификации IntegrationError", async () => {
    const p = new MockMessageProvider("SMS");
    p.failWith = new IntegrationError("temp", { kind: "retryable", platform: "quo" });
    const svc = new MessagingService().register(p);
    const res = await svc.send(cmd({ idempotencyKey: "k-fail" }));
    expect(res.status).toBe("failed");
    expect(res.retryable).toBe(true);
  });

  it("sendMany рассылает в несколько каналов независимо", async () => {
    const providers = createMockProviders();
    const svc = new MessagingService().register(providers.SMS).register(providers.EMAIL).register(providers.TELEGRAM);
    const results = await svc.sendMany([
      cmd({ channel: "SMS", idempotencyKey: "m:sms" }),
      cmd({ channel: "EMAIL", to: "a@b.co", idempotencyKey: "m:email" }),
      cmd({ channel: "TELEGRAM", to: "tg123", idempotencyKey: "m:tg" }),
    ]);
    expect(results.every((r) => r.status === "sent")).toBe(true);
  });
});

describe("renderMessage", () => {
  it("email получает subject, SMS — нет", () => {
    expect(renderMessage("order.ready", "EMAIL", "a@b.co", { orderNumber: "O-1" }).subject).toBeTruthy();
    expect(renderMessage("order.ready", "SMS", "+1", { orderNumber: "O-1" }).subject).toBeNull();
  });
});
