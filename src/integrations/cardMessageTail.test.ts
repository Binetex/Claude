import { describe, it, expect } from "vitest";
import { stripDeliveryTail } from "./cardMessageTail";

describe("срез служебного хвоста с записки", () => {
  it("режет хвост из двух параметров, текст остаётся дословно", () => {
    const note = "С днём рождения! | Delivery Date: Wed Aug 5 2026 | Delivery Time: 11:30 AM - 5:00 PM";
    expect(stripDeliveryTail(note)).toBe("С днём рождения!");
  });

  it("режет хвост из одного параметра", () => {
    expect(stripDeliveryTail("Люблю тебя | Delivery Date: Wed Aug 5 2026")).toBe("Люблю тебя");
  });

  it("записка без хвоста не меняется ни на символ", () => {
    const note = "Happy Birthday, Sarah! Love, Mom";
    expect(stripDeliveryTail(note)).toBe(note);
  });

  it("такой же фрагмент В СЕРЕДИНЕ остаётся — там это может быть текстом клиента", () => {
    const note = "Встречаемся | Delivery Time: 11:30 AM | и не опаздывай";
    expect(stripDeliveryTail(note)).toBe(note);
  });

  it("незнакомый ключ не трогаем", () => {
    const note = "С праздником | Gift Wrap: yes";
    expect(stripDeliveryTail(note)).toBe(note);
  });

  it("незнакомый ключ останавливает срез — то, что за ним, тоже остаётся", () => {
    const note = "Привет | Gift Wrap: yes | Delivery Date: Wed Aug 5 2026";
    expect(stripDeliveryTail(note)).toBe("Привет | Gift Wrap: yes");
  });

  it("регистр ключа не важен", () => {
    expect(stripDeliveryTail("Ура | DELIVERY DATE: Aug 5")).toBe("Ура");
    expect(stripDeliveryTail("Ура | delivery time: 11 AM")).toBe("Ура");
  });

  it("записка целиком из хвоста становится пустой", () => {
    expect(stripDeliveryTail("| Delivery Date: Wed Aug 5 2026 | Delivery Time: 11:30 AM - 5:00 PM")).toBe("");
  });

  it("хвост БЕЗ ведущей черты — клиент не написал ничего", () => {
    // Реальный случай с прода (FLWBR-91145): поздравления нет, и приложение пишет хвост
    // с самого начала, поэтому у первого фрагмента черты перед ним нет.
    expect(stripDeliveryTail("Delivery Date: Sat Jul 11 2026 | Delivery Time: 11:30 AM - 4:00 PM")).toBe("");
    expect(stripDeliveryTail("Delivery Date: Thu Jul 9 2026")).toBe("");
  });

  it("одна строка «ключ: значение» с ЧУЖИМ ключом остаётся — это может быть текст клиента", () => {
    expect(stripDeliveryTail("Note: люблю тебя")).toBe("Note: люблю тебя");
    expect(stripDeliveryTail("Маме: с юбилеем!")).toBe("Маме: с юбилеем!");
  });

  it("поздравление, похожее на «ключ: значение», не пропадает", () => {
    const note = "Дорогая мама: поздравляю тебя | Delivery Date: Sat Jul 11 2026";
    expect(stripDeliveryTail(note)).toBe("Дорогая мама: поздравляю тебя");
  });

  it("переносы строк внутри поздравления сохраняются", () => {
    const note = "Дорогая Мария!\n\nПоздравляю.\nС любовью,\nИван | Delivery Date: Aug 5 2026";
    expect(stripDeliveryTail(note)).toBe("Дорогая Мария!\n\nПоздравляю.\nС любовью,\nИван");
  });

  it("пустая строка и пробелы не ломают функцию", () => {
    expect(stripDeliveryTail("")).toBe("");
    expect(stripDeliveryTail("   ")).toBe("");
  });

  it("значение с дефисами и двоеточиями внутри срезается целиком", () => {
    expect(stripDeliveryTail("Люблю | Delivery Time: 11:30 AM - 5:00 PM")).toBe("Люблю");
  });

  it("текст с вертикальной чертой, но без ключа, не трогаем", () => {
    const note = "Люблю тебя | всегда";
    expect(stripDeliveryTail(note)).toBe(note);
  });
});
