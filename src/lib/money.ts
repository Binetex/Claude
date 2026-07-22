import { Prisma } from "@/generated/prisma/client";

export type Money = Prisma.Decimal | number | string;

/** Форматирует денежную сумму в вид $1,234.50 */
export function formatMoney(value: Money | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "object" ? Number(value) : Number(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(num);
}

/** Число из Decimal/строки/числа */
export function toNumber(value: Money | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "object" ? Number(value) : Number(value);
}
