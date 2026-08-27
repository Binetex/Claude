import { describe, it, expect } from "vitest";
import { getOrderItemImages, orderPhotoUrls } from "./images";

const PARENT = "https://cdn.example/parent.jpg";
const VARIANT = "https://cdn.example/variant.jpg";

describe("getOrderItemImages — основное фото + фото вариации", () => {
  it("товар без вариаций → одно родительское фото, доп. фото нет", () => {
    expect(getOrderItemImages({ image: PARENT, parentImageUrl: PARENT, variantImageUrl: null })).toEqual({
      primary: PARENT,
      variant: null,
    });
  });

  it("вариация со своим фото → основное родительское + доп. фото вариации", () => {
    expect(getOrderItemImages({ image: VARIANT, parentImageUrl: PARENT, variantImageUrl: VARIANT })).toEqual({
      primary: PARENT,
      variant: VARIANT,
    });
  });

  it("вариация без своего фото → только родительское", () => {
    expect(getOrderItemImages({ image: PARENT, parentImageUrl: PARENT, variantImageUrl: null })).toEqual({
      primary: PARENT,
      variant: null,
    });
  });

  it("одинаковые URL не дублируются", () => {
    expect(getOrderItemImages({ image: PARENT, parentImageUrl: PARENT, variantImageUrl: PARENT })).toEqual({
      primary: PARENT,
      variant: null,
    });
  });

  it("старый заказ (только legacy image) → его и показываем, без доп. фото", () => {
    expect(getOrderItemImages({ image: VARIANT, parentImageUrl: null, variantImageUrl: null })).toEqual({
      primary: VARIANT,
      variant: null,
    });
  });

  it("фото нет вовсе → оба null", () => {
    expect(getOrderItemImages({ image: null, parentImageUrl: null, variantImageUrl: null })).toEqual({
      primary: null,
      variant: null,
    });
  });

  it("пустые строки/пробелы считаются отсутствием URL", () => {
    expect(getOrderItemImages({ image: "  ", parentImageUrl: "", variantImageUrl: "   " })).toEqual({
      primary: null,
      variant: null,
    });
  });

  it("вариация есть, а родительского нет → variant не подменяет основное вслепую", () => {
    // primary берётся из legacy image; фото вариации показывается доп., т.к. отличается.
    expect(getOrderItemImages({ image: PARENT, parentImageUrl: null, variantImageUrl: VARIANT })).toEqual({
      primary: PARENT,
      variant: VARIANT,
    });
  });
});

/**
 * Фотографии, которые уходят наружу — сегодня это карточка флориста в Telegram.
 *
 * История: наружу собирались ТОЛЬКО основные фото позиций, и флорист, работающий по телеграму,
 * не видел вазу вовсе — хотя в панели заказа она есть (THEFLOW-20598). Класть в букет не ту
 * вазу дешевле всего именно так: молча.
 */
describe("фотографии заказа наружу", () => {
  const BOUQUET = "https://img/bouquet.jpg";
  const VASE = "https://img/vase.jpg";

  it("фото вариации уходит наружу вместе с товаром", () => {
    expect(orderPhotoUrls([{ parentImageUrl: BOUQUET, variantImageUrl: VASE }])).toEqual([BOUQUET, VASE]);
  });

  it("ваза идёт следом за своим букетом, а не в конце списка", () => {
    // Флорист читает карточку сверху вниз: «вот букет, вот его ваза».
    const photos = orderPhotoUrls([
      { parentImageUrl: BOUQUET, variantImageUrl: VASE },
      { parentImageUrl: "https://img/second.jpg" },
    ]);
    expect(photos).toEqual([BOUQUET, VASE, "https://img/second.jpg"]);
  });

  it("одинаковые позиции не дают одинаковых картинок", () => {
    expect(orderPhotoUrls([{ parentImageUrl: BOUQUET }, { parentImageUrl: BOUQUET }])).toEqual([BOUQUET]);
  });

  it("вариация, совпадающая с товаром, вторым фото не идёт", () => {
    expect(orderPhotoUrls([{ parentImageUrl: BOUQUET, variantImageUrl: BOUQUET }])).toEqual([BOUQUET]);
  });

  it("позиции без фото пропускаются, пустой заказ даёт пустой список", () => {
    expect(orderPhotoUrls([{}, { parentImageUrl: "  " }, { parentImageUrl: BOUQUET }])).toEqual([BOUQUET]);
    expect(orderPhotoUrls([])).toEqual([]);
  });
});
