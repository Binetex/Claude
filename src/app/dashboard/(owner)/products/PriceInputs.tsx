"use client";
import { InlinePrice } from "./InlinePrice";
import { ownerSetProductFloristPrice } from "@/app/dashboard/(owner)/actions";

/** Инлайн-редактор базовой цены флориста товара (для серверной карточки товара). */
export function ProductFloristPriceInput({ productId, initial }: { productId: string; initial: number | null }) {
  return (
    <InlinePrice
      initial={initial}
      allowEmpty
      placeholder="Full Price"
      onSave={(a) => ownerSetProductFloristPrice(productId, a)}
    />
  );
}
