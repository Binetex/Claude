import { describe, it, expect } from "vitest";
import { extractSenderIdentity } from "./orderFields";
import { normalizePhone, toE164 } from "@/lib/phone";

/**
 * Личность заказчика в Shopify-заказе.
 *
 * Правило появилось из реальной потери: в PAR-41318 клиент подставил в платёжный адрес
 * данные ПОЛУЧАТЕЛЯ, старое правило «billing важнее customer» их и записало, а телефон
 * заказчицы (+1 347-260-7553) не сохранился нигде — связаться с ней было не по чему.
 */
describe("имя заказчика", () => {
  it("берётся из customer, а не из платёжного адреса", () => {
    const r = extractSenderIdentity({
      phone: "+13472607553",
      customer: { first_name: "Jamella", last_name: "Aninon", phone: "+13472607553" },
      billing_address: { name: "Aspen Yessayan", phone: "+18646427700" },
      shipping_address: { phone: "+18646427700" },
    });
    expect(r.senderName).toBe("Jamella Aninon");
    expect(r.senderPhone).toBe("+13472607553");
  });

  it("нет customer — имя из платёжного адреса, в том числе разбитое на имя и фамилию", () => {
    expect(extractSenderIdentity({ billing_address: { name: "Aspen Yessayan" } }).senderName).toBe("Aspen Yessayan");
    expect(
      extractSenderIdentity({ billing_address: { first_name: "Anna", last_name: "Ivanova" } }).senderName
    ).toBe("Anna Ivanova");
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

  it("только имя без фамилии не даёт висячего пробела", () => {
    expect(extractSenderIdentity({ customer: { first_name: "Jamella" } }).senderName).toBe("Jamella");
  });

  it("нет ничего — имя «—», телефон пустой (а не мусор)", () => {
    const r = extractSenderIdentity({});
    expect(r.senderName).toBe("—");
    expect(r.senderPhone).toBe("");
  });
});

/**
 * Гарантия, а не набор примеров: перебираем ВСЕ раскладки двух разных номеров по четырём
 * полям Shopify и требуем, чтобы заказчик и получатель никогда не получили один и тот же.
 *
 * Именно это ломалось дважды: сперва заказчику доставался номер из платёжного адреса
 * (PAR-41318 — там лежали данные получателя), потом заказчику доставался номер получателя,
 * когда тот встречался в трёх полях из четырёх. Отдельные примеры оба раза не поймали:
 * ломалась комбинация, которую никто не додумал.
 */
describe("два разных номера в заказе ВСЕГДА расходятся по сторонам", () => {
  const A = "+14150000001";
  const B = "+13230000002";
  const SLOTS = ["shipping", "order", "customer", "billing"] as const;

  const build = (assign: readonly ("A" | "B")[]) => {
    const val = (i: number) => (assign[i] === "A" ? A : B);
    return {
      shipping_address: { phone: val(0) },
      phone: val(1),
      customer: { first_name: "Buyer", phone: val(2) },
      billing_address: { name: "Billing Name", phone: val(3) },
    };
  };

  const layouts: ("A" | "B")[][] = [];
  for (let mask = 0; mask < 16; mask++) layouts.push(SLOTS.map((_, i) => ((mask >> i) & 1 ? "B" : "A")));

  for (const layout of layouts) {
    const both = layout.includes("A") && layout.includes("B");
    const label = SLOTS.map((s, i) => `${s}=${layout[i]}`).join(" ");

    it(both ? `расходятся: ${label}` : `один номер на всех: ${label}`, () => {
      const payload = build(layout);
      // Получатель считается отдельно и всегда из адреса доставки — как в ingestOrder.
      const recipientPhone = normalizePhone(payload.shipping_address.phone);
      const { senderPhone } = extractSenderIdentity(payload);

      expect(senderPhone).toBeTruthy();
      if (both) {
        expect(toE164(senderPhone)).not.toBe(toE164(recipientPhone));
        // И вместе они покрывают оба номера заказа, ни один не потерян.
        expect([toE164(senderPhone), toE164(recipientPhone)].sort()).toEqual([toE164(A), toE164(B)].sort());
      } else {
        // Другого номера в заказе нет — один на двоих это правда, а не потеря.
        expect(toE164(senderPhone)).toBe(toE164(recipientPhone));
      }
    });
  }

  it("формат не мешает: тот же номер в другом написании вторым не считается", () => {
    const r = extractSenderIdentity({
      shipping_address: { phone: "(415) 000-0001" },
      phone: "+14150000001",
      billing_address: { name: "B", phone: B },
    });
    expect(r.senderPhone).toBe(B);
  });

  it("среди ОТЛИЧАЮЩИХСЯ приоритет прежний: заказ важнее учётной записи", () => {
    const C = "+15555555555";
    const r = extractSenderIdentity({
      shipping_address: { phone: A },
      phone: B,
      customer: { first_name: "J", phone: C },
      billing_address: { name: "B", phone: C },
    });
    expect(r.senderPhone).toBe(B);
  });
});

/**
 * Единственный случай, когда правило «два номера расходятся» выполнить нечем.
 *
 * Телефон получателя берётся ТОЛЬКО из адреса доставки — другого основания считать номер
 * «телефоном того, кому везут», не существует. Если магазин его не прислал, поле остаётся
 * пустым: подставить туда второй номер заказчика значило бы выдумать курьеру контакт,
 * которого клиент не давал.
 */
describe("в адресе доставки нет телефона", () => {
  const A = "+14150000001";
  const B = "+13230000002";

  it("заказчик получает свой номер, получатель остаётся без телефона", () => {
    const payload = {
      shipping_address: { phone: "" },
      phone: A,
      customer: { first_name: "Buyer", phone: A },
      billing_address: { name: "B", phone: B },
    };
    expect(normalizePhone(payload.shipping_address.phone)).toBe("");
    expect(extractSenderIdentity(payload).senderPhone).toBe(A);
  });

  it("номер заказчика при этом берётся по обычному приоритету", () => {
    const r = extractSenderIdentity({ shipping_address: { phone: "" }, billing_address: { name: "B", phone: B } });
    expect(r.senderPhone).toBe(B);
  });
});
