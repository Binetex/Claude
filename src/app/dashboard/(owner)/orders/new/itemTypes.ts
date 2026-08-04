/**
 * Позиция в форме ручного заказа — то, что живёт в состоянии страницы до отправки.
 *
 * Отдельный тип от серверного ManualOrderItem: форме нужны ещё и снимки для показа
 * (название, фото, вариант), которые сервер добирает сам из каталога и обратно не ждёт.
 */
import type { FinancialItemType } from "@/generated/prisma/enums";

export type DraftItem = {
  /** Локальный ключ строки. К БД отношения не имеет. */
  key: string;
  kind: "catalog" | "custom";
  productId: string | null;
  variantId: string | null;
  name: string;
  variantName: string | null;
  image: string | null;
  quantity: number;
  customerPrice: number;
  floristPrice: number;
  composition: string | null;
  /** Только у своей позиции: блок «Дополнительно». */
  financialType: FinancialItemType | null;
  purchaseCostCents: number | null;
};

export const emptyCustomItem = (): DraftItem => ({
  key: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  kind: "custom",
  productId: null,
  variantId: null,
  name: "",
  variantName: null,
  image: null,
  quantity: 1,
  customerPrice: 0,
  floristPrice: 0,
  composition: null,
  financialType: null,
  purchaseCostCents: null,
});

export const lineCustomer = (i: DraftItem) => i.customerPrice * i.quantity;
export const lineFlorist = (i: DraftItem) => i.floristPrice * i.quantity;
