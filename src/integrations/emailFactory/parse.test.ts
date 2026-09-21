import { describe, it, expect } from "vitest";
import { parseMessagesForTest } from "./client";
import { orderNumberInSubject } from "./ingest";

/**
 * Ответ провайдера снят с ЖИВОГО API 21.09.2026 и вставлен сюда как есть. Разбор, написанный
 * по другому образцу, молча возвращал пустой список на каждом письме: за всё время работы
 * интеграции в базу не попало ни одного письма от клиента, хотя у провайдера они лежали.
 */
const LIVE_INBOUND = {
  id: "cmubfl91h00cqmltx0a1db9nd",
  threadId: "cmubfl91e00comltxx5ibaajs",
  direction: "INBOUND",
  status: "RECEIVED",
  from: { email: "gabedowrick@gmail.com", name: null },
  to: ["client@juliesflowers.net"],
  cc: [],
  subject: "Re: Заказ JF-1001380",
  text: "Hi,\n\nTry +61 421 254 672",
  html: "<p>Hi</p>",
  messageId: "<CAC5mY10@mail.gmail.com>",
  inReplyTo: "<010001a0c4ad20d1@email.amazonses.com>",
  references: ["<010001a0c4ad20d1@email.amazonses.com>"],
  error: null,
  receivedAt: "2026-09-21T15:59:48.398Z",
  sentAt: null,
  createdAt: "2026-09-21T15:59:53.861Z",
  attachments: [],
};

describe("разбор письма из Email Factory", () => {
  it("адреса приходят объектом и массивом, а не строками", () => {
    const [m] = parseMessagesForTest([LIVE_INBOUND]);
    expect(m).toBeDefined();
    expect(m!.fromEmail).toBe("gabedowrick@gmail.com");
    expect(m!.toEmail).toBe("client@juliesflowers.net");
    expect(m!.threadId).toBe("cmubfl91e00comltxx5ibaajs");
    expect(m!.direction).toBe("INBOUND");
  });

  it("время берётся от получения, а не от записи у провайдера", () => {
    const [m] = parseMessagesForTest([LIVE_INBOUND]);
    expect(m!.occurredAt.toISOString()).toBe("2026-09-21T15:59:48.398Z");
  });

  it("исходящее без receivedAt датируется отправкой", () => {
    const [m] = parseMessagesForTest([{ ...LIVE_INBOUND, direction: "OUTBOUND", receivedAt: null, sentAt: "2026-09-21T15:54:35.417Z" }]);
    expect(m!.occurredAt.toISOString()).toBe("2026-09-21T15:54:35.417Z");
  });

  it("письмо без адреса пропускается целиком, а не кладётся полуфабрикатом", () => {
    expect(parseMessagesForTest([{ ...LIVE_INBOUND, from: { email: null, name: null } }])).toHaveLength(0);
    expect(parseMessagesForTest([{ ...LIVE_INBOUND, to: [] }])).toHaveLength(0);
    expect(parseMessagesForTest([{ ...LIVE_INBOUND, id: null }])).toHaveLength(0);
  });

  it("строковые адреса старого образца тоже читаются", () => {
    const [m] = parseMessagesForTest([{ ...LIVE_INBOUND, from: "a@b.com", to: "c@d.com" }]);
    expect(m!.fromEmail).toBe("a@b.com");
    expect(m!.toEmail).toBe("c@d.com");
  });
});

describe("номер заказа из темы", () => {
  it("находит номер в ответе клиента", () => {
    expect(orderNumberInSubject("Re: Заказ JF-1001380")).toBe("JF-1001380");
    expect(orderNumberInSubject("Заказ THEFLOW-20747")).toBe("THEFLOW-20747");
    expect(orderNumberInSubject("RE: RE: Fwd: Заказ OHARA-1072")).toBe("OHARA-1072");
  });

  it("чужие письма номером заказа не притворяются", () => {
    expect(orderNumberInSubject("USA Prestige Awards 2026/27")).toBeNull();
    expect(orderNumberInSubject("New: Start accepting crypto payments today")).toBeNull();
    expect(orderNumberInSubject("FLORAL DELIVERY ORDER - 9/22")).toBeNull();
    expect(orderNumberInSubject(null)).toBeNull();
  });
});
