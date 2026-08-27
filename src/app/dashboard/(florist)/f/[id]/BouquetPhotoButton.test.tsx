import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BouquetPhotoButton, looksLikeImage } from "./BouquetPhotoButton";

/**
 * Флорист должен иметь выбор, откуда взять фото букета.
 *
 * История: у поля стоял `capture="environment"` — телефон открывал камеру сразу, минуя выбор
 * источника, и снять букет заново было ЕДИНСТВЕННЫМ способом приложить фото. Готовый снимок из
 * галереи прикрепить было нельзя.
 */
describe("что считается фотографией", () => {
  it("HEIC с айфона проходит даже без сообщённого типа", () => {
    // Браузер нередко отдаёт для HEIC пустой тип. Проверка по одному лишь типу отсекала бы
    // исправную фотографию словами «это не изображение» — система врала бы про рабочий файл.
    expect(looksLikeImage({ type: "", name: "IMG_4821.HEIC" } as File)).toBe(true);
    expect(looksLikeImage({ type: "image/heic", name: "photo" } as File)).toBe(true);
  });

  it("обычные снимки проходят", () => {
    expect(looksLikeImage({ type: "image/jpeg", name: "photo.jpg" } as File)).toBe(true);
    expect(looksLikeImage({ type: "", name: "photo.png" } as File)).toBe(true);
  });

  it("не-картинки отсекаются", () => {
    // Из «Файлов» на телефоне выбрать можно что угодно.
    expect(looksLikeImage({ type: "application/pdf", name: "invoice.pdf" } as File)).toBe(false);
    expect(looksLikeImage({ type: "video/quicktime", name: "clip.mov" } as File)).toBe(false);
    expect(looksLikeImage({ type: "", name: "notes.txt" } as File)).toBe(false);
  });
});

describe("кнопка фото букета", () => {
  const html = renderToStaticMarkup(<BouquetPhotoButton orderId="o1" photoUrl={null} />);

  it("не навязывает камеру: атрибута capture нет", () => {
    expect(html).not.toContain("capture");
  });

  it("принимает любое изображение — телефон сам предложит камеру, галерею и файлы", () => {
    expect(html).toContain('accept="image/*,.heic,.heif"');
    expect(html).toContain('type="file"');
  });

  it("когда фото уже есть, кнопка предлагает заменить, а не добавить второе", () => {
    // Фото букета одно на заказ: «добавить» обещало бы галерею, которой нет.
    const withPhoto = renderToStaticMarkup(<BouquetPhotoButton orderId="o1" photoUrl="https://img/x.jpg" />);
    expect(withPhoto).toContain("Заменить фото букета");
  });
});
