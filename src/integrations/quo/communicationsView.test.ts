import { describe, it, expect } from "vitest";
import { isUnreadComm, computeIndicators, isLongText, sortTimelineDesc, buildCommTabs, commGroupOf, type CommForIndicator } from "./communicationsView";

describe("isUnreadComm — только входящие SMS и пропущенные звонки (§7)", () => {
  it("входящее SMS без readAt → unread", () => {
    expect(isUnreadComm({ type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null })).toBe(true);
  });
  it("исходящее SMS → не unread", () => {
    expect(isUnreadComm({ type: "SMS", direction: "OUTBOUND", status: "DELIVERED", readAt: null })).toBe(false);
  });
  it("пропущенный звонок без readAt → unread", () => {
    expect(isUnreadComm({ type: "CALL", direction: "INBOUND", status: "MISSED", readAt: null })).toBe(true);
  });
  it("отвеченный звонок → не unread", () => {
    expect(isUnreadComm({ type: "CALL", direction: "INBOUND", status: "COMPLETED", readAt: null })).toBe(false);
  });
  it("прочитанное → не unread", () => {
    expect(isUnreadComm({ type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: new Date() })).toBe(false);
    expect(isUnreadComm({ type: "CALL", direction: "INBOUND", status: "MISSED", readAt: new Date() })).toBe(false);
  });
});

describe("computeIndicators — агрегаты для списка заказов (§16.4)", () => {
  const comms: CommForIndicator[] = [
    { orderId: "o1", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T10:00:00Z", messageText: "Hi, can you please deliver earlier" },
    { orderId: "o1", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T09:00:00Z", messageText: "older" },
    { orderId: "o1", type: "SMS", direction: "OUTBOUND", status: "DELIVERED", readAt: null, occurredAt: "2026-07-20T08:00:00Z", messageText: "sent" },
    { orderId: "o1", type: "CALL", direction: "INBOUND", status: "MISSED", readAt: null, occurredAt: "2026-07-19T12:00:00Z", messageText: null },
    { orderId: "o2", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: new Date(), occurredAt: "2026-07-20T07:00:00Z", messageText: "already read" },
  ];
  const ind = computeIndicators(comms);

  it("считает непрочитанные входящие SMS", () => {
    expect(ind.o1.unreadInbound).toBe(2);
    expect(ind.o2.unreadInbound).toBe(0); // прочитано
  });
  it("флаг пропущенного звонка", () => {
    expect(ind.o1.hasMissedUnread).toBe(true);
    expect(ind.o2.hasMissedUnread).toBe(false);
  });
  it("последний контакт и preview — от самого свежего сообщения", () => {
    expect(ind.o1.lastAt).toBe("2026-07-20T10:00:00Z");
    expect(ind.o1.preview).toBe("Hi, can you please deliver earlier");
  });
  it("длинный preview усекается", () => {
    const long = computeIndicators([{ orderId: "o3", type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T10:00:00Z", messageText: "x".repeat(80) }]);
    expect(long.o3.preview?.endsWith("…")).toBe(true);
    expect(long.o3.preview!.length).toBeLessThanOrEqual(41);
  });
  it("непривязанные (orderId=null) игнорируются", () => {
    const r = computeIndicators([{ orderId: null, type: "SMS", direction: "INBOUND", status: "RECEIVED", readAt: null, occurredAt: "2026-07-20T10:00:00Z", messageText: "x" }]);
    expect(Object.keys(r)).toHaveLength(0);
  });
});

describe("isLongText / sortTimelineDesc", () => {
  it("длинный текст сворачивается (§16.5)", () => {
    expect(isLongText("a".repeat(301))).toBe(true);
    expect(isLongText("short")).toBe(false);
    expect(isLongText(null)).toBe(false);
  });
  it("лента — новые сверху (§16.1 порядок)", () => {
    const sorted = sortTimelineDesc([{ occurredAt: "2026-07-20T08:00:00Z" }, { occurredAt: "2026-07-20T10:00:00Z" }, { occurredAt: "2026-07-20T09:00:00Z" }]);
    expect(sorted.map((s) => s.occurredAt)).toEqual(["2026-07-20T10:00:00Z", "2026-07-20T09:00:00Z", "2026-07-20T08:00:00Z"]);
  });
});

describe("buildCommTabs — вкладки по стороне заказа", () => {
  it("разные номера → две вкладки: Получатель первым (слева), Заказчик справа", () => {
    const tabs = buildCommTabs("+13105550001", "+13105550002");
    expect(tabs.map((t) => t.label)).toEqual(["Получатель", "Заказчик"]);
    expect(tabs.map((t) => t.target)).toEqual(["RECIPIENT", "CUSTOMER"]);
    expect(tabs[0].target).toBe("RECIPIENT");
    expect(tabs[0].phone).toBe("+13105550002"); // номер получателя
  });

  it("одинаковый номер (в разных форматах) → одна вкладка «Заказчик»", () => {
    const tabs = buildCommTabs("(310) 555-0001", "+13105550001");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ key: "SAME", label: "Заказчик", target: "CUSTOMER" });
  });

  it("матчинг по последним 10 цифрам (игнор +1/форматирования)", () => {
    expect(buildCommTabs("13105550001", "3105550001")).toHaveLength(1); // тот же номер
    expect(buildCommTabs("3105550001", "3105550009")).toHaveLength(2); // разные
  });
});

/**
 * Разбор переписки по вкладкам. Решает ФАКТИЧЕСКИЙ номер сообщения: сохранённая роль
 * ставится один раз при приёме и устаревает, когда телефон заказа исправляют.
 */
describe("commGroupOf — в какую вкладку попадает сообщение", () => {
  const CUST = "+13472607553";
  const RECIP = "+18646427700";
  const msg = (externalPhone: string, partyRole: "CUSTOMER" | "RECIPIENT" | "UNKNOWN" = "UNKNOWN") =>
    ({ externalPhone, partyRole }) as const;

  it("номер получателя → «Получатель», номер заказчика → «Заказчик»", () => {
    expect(commGroupOf(msg(RECIP), CUST, RECIP)).toBe("RECIPIENT");
    expect(commGroupOf(msg(CUST), CUST, RECIP)).toBe("CUSTOMER");
  });

  it("фактический номер важнее сохранённой роли", () => {
    // Ровно случай PAR-41318: переписка шла с получателем, но роль CUSTOMER проставилась,
    // когда оба телефона заказа были одинаковыми.
    expect(commGroupOf(msg(RECIP, "CUSTOMER"), CUST, RECIP)).toBe("RECIPIENT");
    expect(commGroupOf(msg(CUST, "RECIPIENT"), CUST, RECIP)).toBe("CUSTOMER");
  });

  it("формат номера не важен — сравниваются последние 10 цифр", () => {
    expect(commGroupOf(msg("(864) 642-7700"), CUST, RECIP)).toBe("RECIPIENT");
    expect(commGroupOf(msg("1 347 260 7553"), CUST, RECIP)).toBe("CUSTOMER");
  });

  it("номер, не совпавший ни с одной стороной, остаётся по сохранённой роли — вкладок всего две", () => {
    expect(commGroupOf(msg("+15551234567", "CUSTOMER"), CUST, RECIP)).toBe("CUSTOMER");
    expect(commGroupOf(msg("+15551234567", "RECIPIENT"), CUST, RECIP)).toBe("RECIPIENT");
  });

  it("одинаковые телефоны заказа → всё в одной вкладке, включая чужие номера", () => {
    expect(commGroupOf(msg(RECIP, "CUSTOMER"), RECIP, RECIP)).toBe("SAME");
    expect(commGroupOf(msg(RECIP, "RECIPIENT"), RECIP, RECIP)).toBe("SAME");
    expect(commGroupOf(msg("+15551234567"), RECIP, RECIP)).toBe("SAME");
  });

  it("нет номера — решает сохранённая роль, и сообщение всё равно видно", () => {
    expect(commGroupOf(msg("", "RECIPIENT"), CUST, RECIP)).toBe("RECIPIENT");
    expect(commGroupOf(msg("", "CUSTOMER"), CUST, RECIP)).toBe("CUSTOMER");
    // UNKNOWN не прячем: показываем у заказчика, а не теряем.
    expect(commGroupOf(msg("", "UNKNOWN"), CUST, RECIP)).toBe("CUSTOMER");
  });

  it("вкладок ровно две — третьей группы нет", () => {
    expect(buildCommTabs(CUST, RECIP).map((t) => t.key)).toEqual(["RECIPIENT", "CUSTOMER"]);
    expect(buildCommTabs(RECIP, RECIP).map((t) => t.key)).toEqual(["SAME"]);
  });

  it("отправка из каждой вкладки уходит на её собственный номер", () => {
    const tabs = buildCommTabs(CUST, RECIP);
    const recip = tabs.find((t) => t.key === "RECIPIENT")!;
    const cust = tabs.find((t) => t.key === "CUSTOMER")!;
    expect(recip.phone).toBe(RECIP);
    expect(recip.target).toBe("RECIPIENT");
    expect(cust.phone).toBe(CUST);
    expect(cust.target).toBe("CUSTOMER");
  });
});
