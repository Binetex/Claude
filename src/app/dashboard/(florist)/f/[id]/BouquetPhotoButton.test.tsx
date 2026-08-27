import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BouquetPhotoButton } from "./BouquetPhotoButton";

/**
 * Флорист должен иметь выбор, откуда взять фото букета.
 *
 * История: у поля стоял `capture="environment"` — телефон открывал камеру сразу, минуя выбор
 * источника, и снять букет заново было ЕДИНСТВЕННЫМ способом приложить фото. Готовый снимок из
 * галереи прикрепить было нельзя.
 */
describe("кнопка фото букета", () => {
  const html = renderToStaticMarkup(<BouquetPhotoButton orderId="o1" photoUrl={null} />);

  it("не навязывает камеру: атрибута capture нет", () => {
    expect(html).not.toContain("capture");
  });

  it("принимает любое изображение — телефон сам предложит камеру, галерею и файлы", () => {
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('type="file"');
  });

  it("когда фото уже есть, кнопка предлагает заменить, а не добавить второе", () => {
    // Фото букета одно на заказ: «добавить» обещало бы галерею, которой нет.
    const withPhoto = renderToStaticMarkup(<BouquetPhotoButton orderId="o1" photoUrl="https://img/x.jpg" />);
    expect(withPhoto).toContain("Заменить фото букета");
  });
});
