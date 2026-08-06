import { describe, it, expect } from "vitest";
import { extractSenderIdentity } from "./orderFields";

/**
 * Личность заказчика в Shopify-заказе.
 *
 * Правило появилось из реальной потери: в PAR-41318 клиент подставил в платёжный адрес
 * данные ПОЛУЧАТЕЛЯ, старое правило «billing важнее customer» их и записало, а телефон
 * заказчицы (+1 347-260-7553) не сохранился нигде — связаться с ней было не по чему.
 */
describe("заказчик Shopify-заказа", () => {
  it("имя берётся из customer, а не из платёжного адреса", () => {
    const r = extractSenderIdentity({
      phone: "+13472607553",
      customer: { first_name: "Jamella", last_name: "Aninon", phone: "+13472607553" },
      billing_address: { name: "Aspen Yessayan", phone: "+18646427700" },
    });
    expect(r.senderName).toBe("Jamella Aninon");
    expect(r.senderPhone).toBe("+13472607553");
  });

  it("телефон ЗАКАЗА важнее телефона учётной записи", () => {
    const r = extractSenderIdentity({
      phone: "+13472607553",
      customer: { first_name: "J", last_name: "A", phone: "+19995550000" },
      billing_address: { name: "B", phone: "+18646427700" },
    });
    expect(r.senderPhone).toBe("+13472607553");
  });

  it("нет телефона заказа — берётся телефон учётной записи", () => {
    const r = extractSenderIdentity({
      customer: { first_name: "J", last_name: "A", phone: "+19995550000" },
      billing_address: { name: "B", phone: "+18646427700" },
    });
    expect(r.senderPhone).toBe("+19995550000");
  });

  it("платёжный адрес — только последний запасной вариант", () => {
    const r = extractSenderIdentity({ billing_address: { name: "Aspen Yessayan", phone: "+18646427700" } });
    expect(r.senderName).toBe("Aspen Yessayan");
    expect(r.senderPhone).toBe("+18646427700");
  });

  it("нет customer — имя собирается из имени и фамилии платёжного адреса", () => {
    const r = extractSenderIdentity({ billing_address: { first_name: "Anna", last_name: "Ivanova", phone: "3105551234" } });
    expect(r.senderName).toBe("Anna Ivanova");
    // Номер без «+» нормализуется к коду страны — как и везде в проекте.
    expect(r.senderPhone).toBe("+13105551234");
  });

  it("пустой customer не перебивает платёжный адрес", () => {
    // Shopify присылает customer без имени у гостевых заказов.
    const r = extractSenderIdentity({
      customer: { first_name: "", last_name: "", phone: "" },
      billing_address: { name: "Aspen Yessayan", phone: "+18646427700" },
    });
    expect(r.senderName).toBe("Aspen Yessayan");
    expect(r.senderPhone).toBe("+18646427700");
  });

  it("нет ничего — имя «—», телефон пустой (а не мусор)", () => {
    const r = extractSenderIdentity({});
    expect(r.senderName).toBe("—");
    expect(r.senderPhone).toBe("");
  });

  it("источник телефона называется явно — по нему решают, можно ли чинить старые заказы", () => {
    expect(extractSenderIdentity({ phone: "+1347", customer: { phone: "+1999" } }).senderPhoneSource).toBe("order");
    expect(extractSenderIdentity({ customer: { phone: "+1999" } }).senderPhoneSource).toBe("customer");
    expect(extractSenderIdentity({ billing_address: { phone: "+1864" } }).senderPhoneSource).toBe("billing");
    expect(extractSenderIdentity({}).senderPhoneSource).toBe("none");
  });

  it("только имя без фамилии не даёт висячего пробела", () => {
    const r = extractSenderIdentity({ customer: { first_name: "Jamella", phone: "+13472607553" } });
    expect(r.senderName).toBe("Jamella");
  });
});
