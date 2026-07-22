import { describe, it, expect } from "vitest";
import { getOrderItemImages } from "./images";

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
