import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StackedChartTooltip } from "./ChartTooltip";

/**
 * Тултип стопки. Проверяется разметкой, потому что цена ошибки — молча неверная сумма:
 * итог здесь СКЛАДЫВАЕТСЯ из показанных сегментов, поэтому спрятанный сегмент означает
 * итог, не равный настоящему.
 *
 * Особенно это важно на «Обзоре», где сегменты складываются в выручку дня, а прибыль
 * может быть отрицательной: убыточный день обязан показывать минус, а не исчезать.
 */
const SERIES = [
  { key: "florists", name: "Флористы", color: "#635bff" },
  { key: "expenses", name: "Расходы", color: "#f59e0b" },
  { key: "profit", name: "Моя прибыль", color: "#14b8a6" },
];

type Payload = NonNullable<React.ComponentProps<typeof StackedChartTooltip>["payload"]>;

/**
 * Значения в центах, как их отдаёт Recharts. Приведение типа нужно потому, что в его
 * payload лежит десяток служебных полей, из которых тултип читает ровно два.
 */
const render = (values: Record<string, number>) =>
  renderToStaticMarkup(
    <StackedChartTooltip
      active
      payload={Object.entries(values).map(([dataKey, value]) => ({ dataKey, value })) as unknown as Payload}
      series={SERIES}
      title="6 августа 2026"
      subtitle="5 заказов"
      totalLabel="выручка за день"
    />
  );

describe("тултип стопки", () => {
  it("показывает заголовок, подзаголовок и все ненулевые сегменты", () => {
    const html = render({ florists: 39950, expenses: 30000, profit: 20000 });
    expect(html).toContain("6 августа 2026");
    expect(html).toContain("5 заказов");
    expect(html).toContain("Флористы");
    expect(html).toContain("Расходы");
    expect(html).toContain("Моя прибыль");
  });

  it("итог — сумма сегментов", () => {
    const html = render({ florists: 39950, expenses: 30000, profit: 20000 });
    expect(html).toContain("$899.50"); // 399.50 + 300 + 200
  });

  it("ОТРИЦАТЕЛЬНЫЙ сегмент показан и уменьшает итог", () => {
    // Убыточный день: расходы съели выручку. Спрятать минус значило бы показать итог
    // больше настоящего — и это была бы ложь в самом дорогом месте.
    const html = render({ florists: 30000, expenses: 50000, profit: -20000 });
    expect(html).toContain("Моя прибыль");
    expect(html).toContain("-$200.00");
    expect(html).toContain("$600.00"); // 300 + 500 − 200, а не 800
  });

  it("нулевые сегменты не показываются — они ничего не сообщают", () => {
    const html = render({ florists: 30000, expenses: 20000, profit: 0 });
    expect(html).not.toContain("Моя прибыль");
    expect(html).toContain("$500.00");
  });

  it("день без данных — карточка без списка сегментов", () => {
    const html = render({ florists: 0, expenses: 0, profit: 0 });
    expect(html).toContain("6 августа 2026");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("Флористы");
  });

  it("сегменты идут от большего к меньшему", () => {
    const html = render({ florists: 10000, expenses: 50000, profit: 30000 });
    expect(html.indexOf("Расходы")).toBeLessThan(html.indexOf("Моя прибыль"));
    expect(html.indexOf("Моя прибыль")).toBeLessThan(html.indexOf("Флористы"));
  });

  it("без наведения ничего не рисуется", () => {
    expect(
      renderToStaticMarkup(
        <StackedChartTooltip active={false} payload={[] as unknown as Payload} series={SERIES} title="x" totalLabel="y" />
      )
    ).toBe("");
  });
});
