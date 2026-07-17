import { describe, it, expect, vi } from "vitest";
import { EventBus } from "@/events/bus";
import { MessagingService } from "./service";
import { createMockProviders } from "./providers/mock";
import { registerDeliveryNotifications, type OrderNotifyContext } from "./subscribers";

const noSleep = async () => {};

function setup(ctx: OrderNotifyContext | null) {
  const bus = new EventBus({ sleep: noSleep });
  const providers = createMockProviders();
  const svc = new MessagingService()
    .register(providers.SMS)
    .register(providers.EMAIL)
    .register(providers.TELEGRAM);
  const onCompletionSync = vi.fn(async () => {});
  registerDeliveryNotifications(bus, svc, { resolve: async () => ctx, onCompletionSync });
  return { bus, providers, onCompletionSync };
}

describe("registerDeliveryNotifications — фан-аут при доставке", () => {
  it("рассылает SMS/Telegram/email по наличию контактов и запускает completion-sync", async () => {
    const { bus, providers, onCompletionSync } = setup({
      orderNumber: "O-1053",
      senderPhone: "+15551112222",
      senderEmail: "buyer@example.com",
      senderTelegramId: "tg-99",
    });

    await bus.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "o1:done" });

    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.TELEGRAM.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(1);
    expect(providers.SMS.sent[0].message.body).toContain("O-1053");
    expect(onCompletionSync).toHaveBeenCalledWith("o1");
  });

  it("шлёт только по доступным каналам", async () => {
    const { bus, providers } = setup({
      orderNumber: "O-1", senderPhone: "+1", senderEmail: null, senderTelegramId: null,
    });
    await bus.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "k" });
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(0);
    expect(providers.TELEGRAM.sent).toHaveLength(0);
  });

  it("повторная доставка того же события не рассылает дубликаты (idempotency)", async () => {
    const { bus, providers } = setup({
      orderNumber: "O-1", senderPhone: "+1", senderEmail: "a@b.co", senderTelegramId: "tg",
    });
    await bus.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "o1:done" });
    await bus.publish("order.delivery.completed", { orderId: "o1" }, { idempotencyKey: "o1:done" });
    expect(providers.SMS.sent).toHaveLength(1);
    expect(providers.EMAIL.sent).toHaveLength(1);
  });

  it("нет контекста заказа — ничего не шлёт, не падает", async () => {
    const { bus, providers, onCompletionSync } = setup(null);
    await bus.publish("order.delivery.completed", { orderId: "missing" }, { idempotencyKey: "k" });
    expect(providers.SMS.sent).toHaveLength(0);
    expect(onCompletionSync).not.toHaveBeenCalled();
  });
});
