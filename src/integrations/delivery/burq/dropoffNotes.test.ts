import { describe, it, expect } from "vitest";
import { combineDropoffNotes } from "./dropoffNotes";

const SITE = "CALL OR TEXT THE RECIPIENT WHEN YOU ARRIVE. DO NOT LEAVE THE FLOWERS OUTSIDE WITHOUT CONFIRMATION.";
const ORDER = "Gate code 4521. Leave with front desk.";

describe("combineDropoffNotes", () => {
  it("1) только стандартный текст Site → он", () => {
    expect(combineDropoffNotes(SITE, null)).toBe(SITE);
    expect(combineDropoffNotes(SITE, "   ")).toBe(SITE);
  });

  it("2) только инструкция заказа → она", () => {
    expect(combineDropoffNotes(null, ORDER)).toBe(ORDER);
    expect(combineDropoffNotes("", ORDER)).toBe(ORDER);
  });

  it("3) оба → стандартный текст магазина первым, затем инструкция заказа", () => {
    expect(combineDropoffNotes(SITE, ORDER)).toBe(`${SITE}\n${ORDER}`);
  });

  it("4) одинаковый текст / один содержит другой → без дублирования", () => {
    expect(combineDropoffNotes(SITE, SITE)).toBe(SITE);
    expect(combineDropoffNotes(SITE, `${SITE}\nGate code 1`)).toBe(`${SITE}\nGate code 1`); // order содержит site
    expect(combineDropoffNotes(`${ORDER} extra`, ORDER)).toBe(`${ORDER} extra`); // site содержит order
  });

  it("5) оба пустые/whitespace → null (notes не отправляется)", () => {
    expect(combineDropoffNotes(null, null)).toBeNull();
    expect(combineDropoffNotes("", "")).toBeNull();
    expect(combineDropoffNotes("  ", undefined)).toBeNull();
  });

  it("8) значение конкретного Site используется как есть (изоляция между магазинами)", () => {
    expect(combineDropoffNotes("SITE_A default", ORDER)).toBe(`SITE_A default\n${ORDER}`);
    expect(combineDropoffNotes("SITE_B default", ORDER)).toBe(`SITE_B default\n${ORDER}`);
  });
});
