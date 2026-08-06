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

/**
 * Главное правило: если в заказе вообще есть два разных номера, они обязаны разойтись по
 * заказчику и получателю. Одинаковый номер в обоих полях допустим ТОЛЬКО когда другого в
 * заказе нет.
 */
describe("два разных номера не дублируются", () => {
  const A = "+14211111111";
  const B = "+13333333333";

  it("три поля с одним номером, четвёртое с другим — второй достаётся заказчику", () => {
    const r = extractSenderIdentity({
      shipping_address: { phone: A },
      phone: A,
      customer: { first_name: "J", phone: A },
      billing_address: { name: "B", phone: B },
    });
    expect(r.senderPhone).toBe(B); // не A — иначе оба поля были бы одинаковыми
    expect(r.senderPhoneSource).toBe("billing");
  });

  it("лишний номер в заказе — он и достаётся заказчику (случай PAR-41318)", () => {
    const r = extractSenderIdentity({
      shipping_address: { phone: A },
      phone: B,
      customer: { first_name: "J", phone: B },
      billing_address: { name: "B", phone: A },
    });
    expect(r.senderPhone).toBe(B);
    expect(r.senderPhoneSource).toBe("order");
  });

  it("лишний номер в учётной записи", () => {
    const r = extractSenderIdentity({
      shipping_address: { phone: A },
      phone: A,
      customer: { first_name: "J", phone: B },
      billing_address: { name: "B", phone: A },
    });
    expect(r.senderPhone).toBe(B);
    expect(r.senderPhoneSource).toBe("customer");
  });

  it("формат не мешает: тот же номер в другом написании не считается вторым", () => {
    const r = extractSenderIdentity({
      shipping_address: { phone: "(421) 111-1111" },
      phone: "+14211111111",
      billing_address: { name: "B", phone: B },
    });
    expect(r.senderPhone).toBe(B);
  });

  it("в заказе один номер на всех — он и остаётся у обоих", () => {
    const r = extractSenderIdentity({
      shipping_address: { phone: A },
      phone: A,
      customer: { first_name: "J", phone: A },
      billing_address: { name: "B", phone: A },
    });
    expect(r.senderPhone).toBe(A);
  });

  it("приоритет сохраняется среди ОТЛИЧАЮЩИХСЯ: заказ важнее учётной записи", () => {
    const C = "+15555555555";
    const r = extractSenderIdentity({
      shipping_address: { phone: A },
      phone: B,
      customer: { first_name: "J", phone: C },
      billing_address: { name: "B", phone: C },
    });
    expect(r.senderPhone).toBe(B);
    expect(r.senderPhoneSource).toBe("order");
  });

  it("нет телефона доставки — берём первый по приоритету, сравнивать не с чем", () => {
    const r = extractSenderIdentity({ phone: A, billing_address: { name: "B", phone: B } });
    expect(r.senderPhone).toBe(A);
    expect(r.senderPhoneSource).toBe("order");
  });
});

/**
 * Гарантия, а не набор примеров: перебираем ВСЕ раскладки двух разных номеров по четырём
 * полям Shopify и требуем, чтобы заказчик и получатель никогда не получили один и тот же.
 *
 * Именно это ломалось дважды: сперва заказчику доставался номер из платёжного адреса
 * (PAR-41318 — там лежали данные получателя), потом заказчику доставался номер получателя,
 * когда тот встречался в трёх полях из четырёх.
 */
describe("два разных номера в заказе ВСЕГДА расходятся по сторонам", () => {
  const A = "+14150000001";
  const B = "+13230000002";
  const SLOTS = ["shipping", "order", "customer", "billing"] as const;

  /** Собирает payload по раскладке вида ["A","A","A","B"]. */
  const build = (assign: readonly ("A" | "B")[]) => {
    const val = (i: number) => (assign[i] === "A" ? A : B);
    return {
      shipping_address: { phone: val(0) },
      phone: val(1),
      customer: { first_name: "Buyer", phone: val(2) },
      billing_address: { name: "Billing Name", phone: val(3) },
    };
  };

  // 16 раскладок двух номеров по четырём полям; из них 14 содержат оба номера.
  const layouts: ("A" | "B")[][] = [];
  for (let mask = 0; mask < 16; mask++) {
    layouts.push(SLOTS.map((_, i) => ((mask >> i) & 1 ? "B" : "A")));
  }

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
    expect(r.senderPhoneSource).toBe("billing");
  });
});
