import { describe, it, expect } from "vitest";
import { bouquetMediaName, bouquetPageUrl } from "./bouquetPage";

/** Ссылка клиенту строится только из НАШЕГО фото: чужой адрес в SMS не уходит никогда. */
describe("страница фото букета", () => {
  it("из внутренней ссылки на фото получается адрес страницы", () => {
    expect(bouquetPageUrl("/api/media/3f2a9c1e-7b4d-4c6a-9e1f-0a1b2c3d4e5f.jpg")).toMatch(/\/bouquet\/3f2a9c1e-7b4d-4c6a-9e1f-0a1b2c3d4e5f\.jpg$/);
  });

  it("фото нет — ссылки нет", () => {
    expect(bouquetPageUrl(null)).toBeNull();
    expect(bouquetPageUrl("")).toBeNull();
  });

  it("чужой адрес и подмена пути не проходят", () => {
    expect(bouquetMediaName("https://evil.example/api/media/x.jpg")).toBe("x.jpg"); // хост срезается, имя проверяется отдельно
    expect(bouquetMediaName("/api/media/../secret")).toBeNull();
    expect(bouquetMediaName("/uploads/x.jpg")).toBeNull();
  });
});
