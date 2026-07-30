import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBrevoProvider, isValidEmail, normalizeEmail, isBrevoConfigured, verifyBrevoApiKey } from "./brevo";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const baseParams = {
  to: "customer@example.com",
  brevoTemplateId: 7,
  params: { order_number: "#1" },
  sender: { email: "orders@theflow.la", name: "The Flow" },
};

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env.BREVO_API_KEY;
});

describe("проверка адресов", () => {
  it("принимает обычные адреса, в том числе с плюсом и поддоменом", () => {
    for (const v of ["a@b.co", "customer+tag@mail.example.com", "Ivan.Petrov@example.org"]) {
      expect(isValidEmail(v)).toBe(true);
    }
  });

  it("отвергает мусор", () => {
    for (const v of ["", "  ", "no-at-sign", "a@b", "a@@b.co", "a b@c.co", null, undefined]) {
      expect(isValidEmail(v as string)).toBe(false);
    }
  });

  it("нормализует к нижнему регистру и без пробелов", () => {
    expect(normalizeEmail("  Ivan@Example.COM ")).toBe("ivan@example.com");
    expect(normalizeEmail("не-адрес")).toBeNull();
  });
});

describe("отсутствие ключа не ломает приложение", () => {
  it("без BREVO_API_KEY возвращается статус конфигурации, а не исключение", async () => {
    const res = await createBrevoProvider().sendTemplate(baseParams);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("email_not_configured");
    expect(res.configuration).toBe(true);
    expect(res.retryable).toBe(false);
    // В сеть при этом не ходим вовсе.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isBrevoConfigured отражает наличие ключа", () => {
    expect(isBrevoConfigured()).toBe(false);
    process.env.BREVO_API_KEY = "key";
    expect(isBrevoConfigured()).toBe(true);
  });
});

describe("отправка письма", () => {
  beforeEach(() => {
    process.env.BREVO_API_KEY = "test-key";
  });

  it("успех возвращает messageId провайдера", async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: "<abc@brevo>" }));
    const res = await createBrevoProvider().sendTemplate(baseParams);
    expect(res).toEqual({ ok: true, providerMessageId: "<abc@brevo>" });
  });

  it("ключ уходит в заголовке api-key и НЕ попадает в тело", async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    await createBrevoProvider().sendTemplate(baseParams);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["api-key"]).toBe("test-key");
    expect(init.body).not.toContain("test-key");
  });

  it("шаблон, переменные и получатель передаются как ждёт Brevo", async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    await createBrevoProvider().sendTemplate({ ...baseParams, replyTo: "help@theflow.la", toName: "Иван" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.templateId).toBe(7);
    expect(body.params).toEqual({ order_number: "#1" });
    expect(body.to).toEqual([{ email: "customer@example.com", name: "Иван" }]);
    expect(body.replyTo).toEqual({ email: "help@theflow.la" });
    expect(body.sender).toEqual({ email: "orders@theflow.la", name: "The Flow" });
  });

  it("числовой brevoSenderId предпочитается паре email+name", async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    await createBrevoProvider().sendTemplate({ ...baseParams, sender: { ...baseParams.sender, brevoSenderId: "42" } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender).toEqual({ id: 42 });
  });

  it("нецифровой brevoSenderId игнорируется, отправка идёт по email", async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    await createBrevoProvider().sendTemplate({ ...baseParams, sender: { ...baseParams.sender, brevoSenderId: "не-число" } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.sender.email).toBe("orders@theflow.la");
  });

  it("адрес получателя нормализуется перед отправкой", async () => {
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    await createBrevoProvider().sendTemplate({ ...baseParams, to: "  Customer@Example.COM " });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.to[0].email).toBe("customer@example.com");
  });
});

describe("ошибки провайдера", () => {
  beforeEach(() => {
    process.env.BREVO_API_KEY = "test-key";
  });

  it("некорректный получатель отсекается до сети", async () => {
    const res = await createBrevoProvider().sendTemplate({ ...baseParams, to: "мусор" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_recipient_email");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("незаданный шаблон — проблема конфигурации, а не сбой", async () => {
    const res = await createBrevoProvider().sendTemplate({ ...baseParams, brevoTemplateId: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("invalid_template_id");
    expect(res.configuration).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 — проблема ключа: не повторяем", async () => {
    fetchMock.mockResolvedValue(json(401, { message: "unauthorized" }));
    const res = await createBrevoProvider().sendTemplate(baseParams);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("brevo_unauthorized");
    expect(res.retryable).toBe(false);
    expect(res.configuration).toBe(true);
  });

  it("429 и 5xx помечаются повторяемыми", async () => {
    for (const [status, code] of [[429, "brevo_rate_limit"], [500, "brevo_server"], [503, "brevo_server"]] as const) {
      fetchMock.mockResolvedValue(json(status, { message: "later" }));
      const res = await createBrevoProvider().sendTemplate(baseParams);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe(code);
      expect(res.retryable).toBe(true);
    }
  });

  it("400 различает неверный шаблон и неподтверждённого отправителя", async () => {
    fetchMock.mockResolvedValue(json(400, { message: "templateId does not exist" }));
    const a = await createBrevoProvider().sendTemplate(baseParams);
    expect(a.ok === false && a.code).toBe("brevo_template_invalid");

    fetchMock.mockResolvedValue(json(400, { message: "sender not valid" }));
    const b = await createBrevoProvider().sendTemplate(baseParams);
    expect(b.ok === false && b.code).toBe("brevo_sender_invalid");
  });

  it("сетевой сбой повторяем, текст ошибки безопасный", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET at 10.0.0.1"));
    const res = await createBrevoProvider().sendTemplate(baseParams);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("brevo_network");
    expect(res.retryable).toBe(true);
    expect(res.safeError).not.toContain("10.0.0.1");
  });

  it("ответ провайдера не протекает в safeError (там может быть адрес клиента)", async () => {
    fetchMock.mockResolvedValue(json(400, { message: "invalid recipient customer@example.com" }));
    const res = await createBrevoProvider().sendTemplate(baseParams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.safeError).not.toContain("customer@example.com");
  });

  it("успешный ответ без JSON не считается ошибкой", async () => {
    // 204 по стандарту не имеет тела — передаём null, иначе Response не создастся.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await createBrevoProvider().sendTemplate(baseParams);
    expect(res).toEqual({ ok: true, providerMessageId: null });
  });
});

describe("ключ, переданный явно (из БД), приоритетнее env", () => {
  it("apiKeyOverride используется вместо env, даже если env не задан", async () => {
    delete process.env.BREVO_API_KEY; // явно нет env — override всё равно должен сработать
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    const res = await createBrevoProvider("db-key-123").sendTemplate(baseParams);
    expect(res).toEqual({ ok: true, providerMessageId: "m" });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["api-key"]).toBe("db-key-123");
  });

  it("apiKeyOverride=null — конфигурация отсутствует, даже если env задан", async () => {
    process.env.BREVO_API_KEY = "env-key";
    const res = await createBrevoProvider(null).sendTemplate(baseParams);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("email_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("apiKeyOverride не передан (undefined) — как раньше, читаем env", async () => {
    process.env.BREVO_API_KEY = "env-key";
    fetchMock.mockResolvedValue(json(201, { messageId: "m" }));
    await createBrevoProvider().sendTemplate(baseParams);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["api-key"]).toBe("env-key");
  });
});

describe("verifyBrevoApiKey — GET /v3/account", () => {
  it("успех возвращает email аккаунта, ничего не отправляя", async () => {
    fetchMock.mockResolvedValue(json(200, { email: "agency@example.com" }));
    const res = await verifyBrevoApiKey("some-key");
    expect(res).toEqual({ ok: true, accountEmail: "agency@example.com" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.brevo.com/v3/account");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("401 — ключ невалиден", async () => {
    fetchMock.mockResolvedValue(json(401, { message: "unauthorized" }));
    const res = await verifyBrevoApiKey("bad-key");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("brevo_unauthorized");
  });

  it("пустой ключ — не ходим в сеть", async () => {
    const res = await verifyBrevoApiKey("   ");
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("сетевой сбой — безопасная ошибка без утечки деталей", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET at 10.0.0.1"));
    const res = await verifyBrevoApiKey("some-key");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("brevo_network");
      expect(res.safeError).not.toContain("10.0.0.1");
    }
  });
});
