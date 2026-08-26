import { describe, it, expect } from "vitest";
import { pickLocation, pickedReviewUrl, normalizeZip, type PickableLocation } from "./locationPick";

/**
 * Выбор точки для заказа. Индексы взяты настоящие, лос-анджелесские, и расстояния между ними
 * можно сверить по карте: даунтаун (90017), Mar Vista (90066), Palms (90064), Пасадена (91101).
 */
const loc = (over: Partial<PickableLocation> = {}): PickableLocation => ({
  id: "l1",
  name: "Downtown",
  reviewUrl: "https://g.page/r/dt/review",
  zipCode: "90017",
  isDefault: false,
  isActive: true,
  ...over,
});

describe("нормализация индекса", () => {
  it("ZIP+4 и пробелы приводятся к пяти цифрам", () => {
    // В заказах встречается «90056-1234»; без этого адрес не нашёлся бы в таблице координат.
    expect(normalizeZip(" 90056-1234 ")).toBe("90056");
    expect(normalizeZip("90056")).toBe("90056");
  });

  it("мусор и пустота дают пустую строку, а не подобие индекса", () => {
    for (const junk of ["", "   ", "—", null, undefined]) expect(normalizeZip(junk)).toBe("");
  });
});

describe("ближайшая точка", () => {
  const downtown = loc({ id: "dt", name: "Downtown", zipCode: "90017", reviewUrl: "https://g.page/r/dt/review" });
  const marVista = loc({ id: "mv", name: "Mar Vista", zipCode: "90066", reviewUrl: "https://g.page/r/mv/review" });

  it("адрес рядом с одной точкой уходит именно к ней", () => {
    // 90064 (Palms) в паре миль от Mar Vista и почти в десяти от даунтауна.
    const res = pickLocation("90064", [downtown, marVista], null);
    expect(res).toMatchObject({ ok: true, reason: "nearest", location: { id: "mv" } });
    expect(pickedReviewUrl(res)).toBe("https://g.page/r/mv/review");
  });

  it("адрес в самом центре уходит в центральную точку", () => {
    expect(pickLocation("90013", [downtown, marVista], null)).toMatchObject({ location: { id: "dt" } });
  });

  it("порядок точек в списке ничего не решает — решает расстояние", () => {
    const a = pickLocation("90064", [downtown, marVista], null);
    const b = pickLocation("90064", [marVista, downtown], null);
    expect(a).toMatchObject({ location: { id: "mv" } });
    expect(b).toMatchObject({ location: { id: "mv" } });
  });

  it("расстояние возвращается наружу — экрану проверки есть что показать", () => {
    const res = pickLocation("90066", [downtown, marVista], null);
    expect(res.ok && res.reason === "nearest" && res.distanceMiles).toBeLessThan(2);
  });

  it("ZIP+4 в заказе тоже находит ближайшую", () => {
    expect(pickLocation("90064-1234", [downtown, marVista], null)).toMatchObject({ location: { id: "mv" } });
  });

  it("выключенная точка не участвует, даже если она ближе всех", () => {
    const res = pickLocation("90064", [downtown, { ...marVista, isActive: false }], null);
    expect(res).toMatchObject({ reason: "nearest", location: { id: "dt" } });
  });

  it("точка без своего индекса в расчёте не участвует", () => {
    // Без координат она не достанется ни одному заказу; поэтому пустой индекс и не сохраняем.
    const nameless = loc({ id: "x", zipCode: null });
    expect(pickLocation("90064", [nameless, marVista], null)).toMatchObject({ location: { id: "mv" } });
  });
});

describe("равное расстояние", () => {
  // Две точки в одном индексе — обычное дело: два магазина в одном районе. Географически они
  // неразличимы, и выбор обязан быть одинаковым при любом порядке строк из базы: запросы идут
  // без orderBy, а порядок строк Postgres не гарантирует.
  const twinA = loc({ id: "aaa", name: "A", zipCode: "90066", reviewUrl: "https://g.page/r/a/review" });
  const twinB = loc({ id: "bbb", name: "B", zipCode: "90066", reviewUrl: "https://g.page/r/b/review" });

  it("побеждает одна и та же точка независимо от порядка в списке", () => {
    const direct = pickLocation("90064", [twinA, twinB], null);
    const reversed = pickLocation("90064", [twinB, twinA], null);
    expect(direct).toMatchObject({ location: { id: "aaa" } });
    expect(reversed).toMatchObject({ location: { id: "aaa" } });
  });

  it("и клиент получает одну и ту же ссылку", () => {
    expect(pickedReviewUrl(pickLocation("90064", [twinA, twinB], null))).toBe(
      pickedReviewUrl(pickLocation("90064", [twinB, twinA], null))
    );
  });

  it("на более близкую точку правило равенства не влияет", () => {
    const closer = loc({ id: "zzz", name: "Ближе", zipCode: "90064" });
    // id «zzz» проигрывает по алфавиту, но выигрывает по расстоянию — расстояние важнее.
    expect(pickLocation("90064", [twinA, closer], null)).toMatchObject({ location: { id: "zzz" } });
  });
});

describe("когда география не помогает", () => {
  const marVista = loc({ id: "mv", zipCode: "90066" });
  const spare = loc({ id: "sp", name: "Запасная", zipCode: null, isDefault: true, reviewUrl: "https://g.page/r/sp/review" });

  it("неизвестный индекс заказа уводит на запасную точку", () => {
    // Абонентские ящики и новые коды в таблице отсутствуют — это обычное дело, не ошибка.
    const res = pickLocation("00000", [marVista, spare], null);
    expect(res).toMatchObject({ ok: true, reason: "default", location: { id: "sp" } });
  });

  it("пустой индекс заказа — тоже запасная", () => {
    expect(pickLocation("", [marVista, spare], null)).toMatchObject({ reason: "default" });
  });

  it("ни одной точки с индексом — запасная", () => {
    const noZip = loc({ id: "n", zipCode: null });
    expect(pickLocation("90064", [noZip, spare], null)).toMatchObject({ reason: "default", location: { id: "sp" } });
  });

  it("точек нет — работает старая ссылка магазина", () => {
    // Она кормит живые рассылки; пока справочник не заполнен, заказ всё равно получит ссылку.
    const res = pickLocation("90064", [], "https://site/review");
    expect(res).toMatchObject({ ok: true, reason: "site_fallback" });
    expect(pickedReviewUrl(res)).toBe("https://site/review");
  });

  it("нет ни точек, ни старой ссылки — честный отказ, а не пустая строка", () => {
    const res = pickLocation("90064", [], null);
    expect(res).toEqual({ ok: false, error: "no_location" });
    expect(pickedReviewUrl(res)).toBeNull();
  });

  it("далёкий заказ всё равно уходит к ближайшей, а не к запасной", () => {
    // Пасадена далеко от обеих точек, но география работает: запасная нужна только когда
    // считать нечего.
    expect(pickLocation("91101", [marVista, spare], null)).toMatchObject({ reason: "nearest", location: { id: "mv" } });
  });
});
