/**
 * Чистая логика цепочек: валидация редактора и выбор следующего шага.
 * Без БД и без outbox — те же функции, что вызывают server action и движок.
 */
import { describe, it, expect } from "vitest";
import { validateFlow, validateFlowStep, validateStepPositions, type FlowStepInput } from "./validation";
import { nextStepAfter, channelOfStepType, type FlowStepRow } from "./engine";
import { flowStepSummary, waitLabel } from "./display";

const step = (over: Partial<FlowStepInput> & { position: number; type: FlowStepInput["type"] }): FlowStepInput => ({
  waitAmount: null,
  waitUnit: null,
  brevoTemplateId: null,
  template: null,
  ...over,
});

const wait2days = step({ position: 1, type: "WAIT", waitAmount: 2, waitUnit: "DAY" });
const emailStep = step({ position: 2, type: "EMAIL", brevoTemplateId: 12 });
const smsStep = step({ position: 2, type: "SMS", template: "Спасибо за заказ {{order_number}}" });

const flow = (steps: FlowStepInput[]) => ({
  name: "Просьба об отзыве",
  siteIds: ["site-1"],
  triggerType: "ORDER_DELIVERED",
  active: false,
  steps,
});

describe("validateFlow", () => {
  it("первый рабочий сценарий (WAIT 2 дня → EMAIL) валиден", () => {
    expect(validateFlow(flow([wait2days, emailStep]))).toBeNull();
  });

  it("цепочка без шагов не сохраняется", () => {
    expect(validateFlow(flow([]))).toMatch(/хотя бы один шаг/i);
  });

  it("последним шагом не может быть ожидание", () => {
    const emailFirst = step({ position: 1, type: "EMAIL", brevoTemplateId: 12 });
    const waitLast = step({ position: 2, type: "WAIT", waitAmount: 1, waitUnit: "DAY" });
    expect(validateFlow(flow([emailFirst, waitLast]))).toMatch(/Последним шагом/i);
  });

  it("нужен хотя бы один магазин", () => {
    expect(validateFlow({ ...flow([wait2days, emailStep]), siteIds: [] })).toMatch(/магазин/i);
  });

  it("название обязательно", () => {
    expect(validateFlow({ ...flow([wait2days, emailStep]), name: "  " })).toMatch(/название/i);
  });

  it("неизвестный триггер отклоняется", () => {
    expect(validateFlow({ ...flow([wait2days, emailStep]), triggerType: "ANNIVERSARY" })).toMatch(/триггер/i);
  });

  it("«Запускается по цепочке» маркетинговой цепочке недоступно", () => {
    // Триггер известный (isSupportedTrigger его пропускает), но своего события у него нет: его
    // зовёт предыдущее ПРАВИЛО поимённо. Цепочка с ним не сработала бы никогда и молча.
    expect(validateFlow({ ...flow([wait2days, emailStep]), triggerType: "CHAINED" })).toMatch(/цепочк/i);
  });
});

describe("validateFlowStep", () => {
  it("WAIT требует положительное количество и единицу", () => {
    expect(validateFlowStep(step({ position: 1, type: "WAIT", waitUnit: "DAY" }), 0)).toMatch(/количество/i);
    expect(validateFlowStep(step({ position: 1, type: "WAIT", waitAmount: 0, waitUnit: "DAY" }), 0)).toMatch(/количество/i);
    expect(validateFlowStep(step({ position: 1, type: "WAIT", waitAmount: 2 }), 0)).toMatch(/единица/i);
    expect(validateFlowStep(wait2days, 0)).toBeNull();
  });

  it("EMAIL требует Brevo Template ID", () => {
    expect(validateFlowStep(step({ position: 1, type: "EMAIL" }), 0)).toMatch(/Template ID/i);
    expect(validateFlowStep(step({ position: 1, type: "EMAIL", brevoTemplateId: 0 }), 0)).toMatch(/Template ID/i);
    expect(validateFlowStep(step({ position: 1, type: "EMAIL", brevoTemplateId: 12 }), 0)).toBeNull();
  });

  it("SMS требует непустой текст", () => {
    expect(validateFlowStep(step({ position: 1, type: "SMS", template: "   " }), 0)).toMatch(/текст SMS/i);
    expect(validateFlowStep(step({ position: 1, type: "SMS", template: "x".repeat(1601) }), 0)).toMatch(/длинный/i);
    expect(validateFlowStep(smsStep, 0)).toBeNull();
  });

  it("номер шага в сообщении соответствует позиции в списке", () => {
    expect(validateFlowStep(step({ position: 3, type: "EMAIL" }), 2)).toMatch(/^Шаг 3/);
  });
});

describe("validateStepPositions", () => {
  it("позиции обязаны идти подряд с 1", () => {
    expect(validateStepPositions([1, 2, 3])).toBeNull();
    expect(validateStepPositions([1, 3])).toMatch(/подряд/i);
    expect(validateStepPositions([0, 1])).toMatch(/подряд/i);
    expect(validateStepPositions([2, 1])).toBeNull(); // порядок в массиве не важен, важен набор
  });
});

describe("nextStepAfter", () => {
  const rows: FlowStepRow[] = [
    { id: "a", position: 1, type: "WAIT", waitAmount: 2, waitUnit: "DAY", deletedAt: null },
    { id: "b", position: 2, type: "EMAIL", waitAmount: null, waitUnit: null, deletedAt: null },
    { id: "c", position: 3, type: "SMS", waitAmount: null, waitUnit: null, deletedAt: null },
  ];

  it("со старта берётся первый шаг", () => {
    expect(nextStepAfter(rows, 0)?.id).toBe("a");
  });

  it("после шага берётся следующий по позиции", () => {
    expect(nextStepAfter(rows, 1)?.id).toBe("b");
    expect(nextStepAfter(rows, 2)?.id).toBe("c");
  });

  it("после последнего шага следующего нет", () => {
    expect(nextStepAfter(rows, 3)).toBeNull();
  });

  it("удалённые шаги пропускаются", () => {
    const withDeleted = rows.map((r) => (r.id === "b" ? { ...r, deletedAt: new Date() } : r));
    expect(nextStepAfter(withDeleted, 1)?.id).toBe("c");
  });
});

describe("подписи", () => {
  it("канал шага", () => {
    expect(channelOfStepType("WAIT")).toBeNull();
    expect(channelOfStepType("EMAIL")).toBe("EMAIL");
    expect(channelOfStepType("SMS")).toBe("SMS");
  });

  it("склонение единиц ожидания", () => {
    expect(waitLabel(1, "DAY")).toBe("1 день");
    expect(waitLabel(2, "DAY")).toBe("2 дня");
    expect(waitLabel(5, "DAY")).toBe("5 дней");
    expect(waitLabel(11, "DAY")).toBe("11 дней");
    expect(waitLabel(21, "HOUR")).toBe("21 час");
  });

  it("однострочное описание шага", () => {
    expect(flowStepSummary({ type: "WAIT", waitAmount: 2, waitUnit: "DAY" })).toBe("Ждать 2 дня");
    expect(flowStepSummary({ type: "EMAIL", brevoTemplateId: 12 })).toMatch(/#12/);
    expect(flowStepSummary({ type: "EMAIL", brevoTemplateId: null })).toMatch(/не задан/i);
    expect(flowStepSummary({ type: "SMS", template: "Привет" })).toMatch(/Привет/);
  });
});
