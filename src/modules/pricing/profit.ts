/**
 * Примерная прибыль владельца по заказу. Чистая функция — считается ОДИНАКОВО везде:
 * в карточке заказа, в сводке дашборда и при записи Order.estimatedProfit.
 *
 * Доход (всё, что заплатил клиент):
 *   товары + налог + чаевые + доставка (заказчик)
 * Расход (всё, что платим мы):
 *   цена флориста + доставка (факт)
 *
 * Почему именно так:
 *  - «Доставка (заказчик)» — это ДОХОД: клиент уже заплатил нам за доставку. Раньше её в
 *    формуле не было вовсе, и прибыль занижалась на всю эту сумму;
 *  - чаевые целиком забирает владелец;
 *  - налог включён в доход по решению владельца (осознанно, как временное правило);
 *  - СКИДКА отдельно НЕ вычитается: на реальных данных customerTotal сходится с суммой
 *    товары+налог+чаевые+доставка (219 из 220 заказов), то есть скидка уже учтена внутри
 *    itemsTotal. Вычитать её ещё раз означало бы посчитать дважды.
 */
export type ProfitParts = {
  itemsTotal: number;
  tax: number;
  tip: number;
  deliveryCustomerCost: number;
  floristTotal: number;
  deliveryActualCost: number;
};

export function computeEstimatedProfit(p: ProfitParts): number {
  const income = p.itemsTotal + p.tax + p.tip + p.deliveryCustomerCost;
  const cost = p.floristTotal + p.deliveryActualCost;
  // Деньги: округляем до центов, чтобы не тащить погрешность double в отображение и суммы.
  return Math.round((income - cost) * 100) / 100;
}
