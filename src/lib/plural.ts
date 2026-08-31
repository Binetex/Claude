/**
 * Русское склонение после числа: «1 заказ», «2 заказа», «5 заказов».
 *
 * Одна реализация на весь проект. До этого копий было четыре — в автоматизациях, в цепочках,
 * в финансах и на экране флористов, — и с четырьмя копиями однажды уже уехало «Заказа 2»
 * вместо «2 заказа»: правило поправили в одном месте и не поправили в остальных.
 */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
