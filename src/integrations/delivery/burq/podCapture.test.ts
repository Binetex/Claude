import { describe, it, expect } from "vitest";
import { normalizePodUrls, normalizeSignatureUrl, decidePodUpdate, isDeliveredWithoutPhoto } from "./podCapture";

describe("normalizePodUrls", () => {
  it("массив URL парсится; только http(s); дубли убираются", () => {
    expect(normalizePodUrls(["https://a/1.jpg", "http://b/2.png", "https://a/1.jpg", "not-a-url", ""])).toEqual([
      "https://a/1.jpg",
      "http://b/2.png",
    ]);
  });
  it("пустой массив / не массив → []", () => {
    expect(normalizePodUrls([])).toEqual([]);
    expect(normalizePodUrls(null)).toEqual([]);
    expect(normalizePodUrls(undefined)).toEqual([]);
    expect(normalizePodUrls("x")).toEqual([]);
  });
});

describe("normalizeSignatureUrl", () => {
  it("валидный http(s) → строка; иначе null", () => {
    expect(normalizeSignatureUrl("https://s/sig.png")).toBe("https://s/sig.png");
    expect(normalizeSignatureUrl("nope")).toBeNull();
    expect(normalizeSignatureUrl(null)).toBeNull();
  });
});

describe("decidePodUpdate", () => {
  it("есть фото → apply с массивом", () => {
    expect(decidePodUpdate({ proofOfDeliveryUrls: ["https://a/1.jpg"] })).toEqual({ apply: true, proofOfDeliveryUrls: ["https://a/1.jpg"] });
  });
  it("есть подпись → apply с signatureImageUrl", () => {
    expect(decidePodUpdate({ signatureImageUrl: "https://s/sig.png" })).toEqual({ apply: true, signatureImageUrl: "https://s/sig.png" });
  });
  it("пусто → apply:false (старое не обнуляем)", () => {
    expect(decidePodUpdate({ proofOfDeliveryUrls: [], signatureImageUrl: null })).toEqual({ apply: false });
    expect(decidePodUpdate({})).toEqual({ apply: false });
  });
  it("повтор одинаковых URL не даёт дублей (массив заменяется, дедуп)", () => {
    const r = decidePodUpdate({ proofOfDeliveryUrls: ["https://a/1.jpg", "https://a/1.jpg"] });
    expect(r).toEqual({ apply: true, proofOfDeliveryUrls: ["https://a/1.jpg"] });
  });
});

describe("isDeliveredWithoutPhoto", () => {
  it("delivered + нет фото → true (нужен отложенный refetch)", () => {
    expect(isDeliveredWithoutPhoto("DELIVERED", [])).toBe(true);
    expect(isDeliveredWithoutPhoto("DELIVERED", null)).toBe(true);
  });
  it("delivered + есть фото → false", () => {
    expect(isDeliveredWithoutPhoto("DELIVERED", ["https://a/1.jpg"])).toBe(false);
  });
  it("не delivered → false (пустое фото до доставки — не ошибка)", () => {
    expect(isDeliveredWithoutPhoto("IN_TRANSIT", [])).toBe(false);
  });
});
