"use client";
/**
 * Редактор цепочки: шапка (название/событие/магазины) + ВЕРТИКАЛЬНЫЙ список шагов.
 * Порядок меняется кнопками ↑/↓ — drag-and-drop сознательно не делаем.
 *
 * Клиентская проверка использует тот же чистый модуль валидации, что и server action:
 * подсказка появляется сразу, но авторитет — всегда сервер.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { SiteMultiSelect, type SiteOption } from "../SiteMultiSelect";
import { createFlow, updateFlow, type FlowStepDTO } from "./actions";
import { FLOW_STEP_TYPE_LABELS } from "@/modules/automations/flows/display";
import { validateFlow, FLOW_WAIT_UNITS, type FlowStepTypeInput, type FlowWaitUnit } from "@/modules/automations/flows/validation";

type TriggerOpt = { type: string; label: string; description: string };
type VarDef = { key: string; label: string; example: string };

export type FlowFormInitial = {
  id: string;
  name: string;
  active: boolean;
  triggerType: string;
  siteIds: string[];
  steps: FlowStepDTO[];
};

const WAIT_UNIT_LABELS: Record<FlowWaitUnit, string> = { MINUTE: "минут", HOUR: "часов", DAY: "дней" };

/** Шаг в состоянии формы: числа держим строками, чтобы поле можно было временно очистить. */
type StepDraft = {
  id: string | null;
  type: FlowStepTypeInput;
  waitAmount: string;
  waitUnit: FlowWaitUnit;
  brevoTemplateId: string;
  template: string;
};

function toDraft(s: FlowStepDTO): StepDraft {
  return {
    id: s.id ?? null,
    type: s.type,
    waitAmount: s.waitAmount != null ? String(s.waitAmount) : "",
    waitUnit: s.waitUnit ?? "DAY",
    brevoTemplateId: s.brevoTemplateId != null ? String(s.brevoTemplateId) : "",
    template: s.template ?? "",
  };
}

function toDTO(d: StepDraft): FlowStepDTO {
  const num = (v: string) => {
    const n = Number(v.trim());
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  return {
    id: d.id,
    type: d.type,
    waitAmount: d.type === "WAIT" ? num(d.waitAmount) : null,
    waitUnit: d.type === "WAIT" ? d.waitUnit : null,
    brevoTemplateId: d.type === "EMAIL" ? num(d.brevoTemplateId) : null,
    template: d.type === "SMS" ? d.template : null,
  };
}

function emptyStep(type: FlowStepTypeInput): StepDraft {
  return { id: null, type, waitAmount: type === "WAIT" ? "1" : "", waitUnit: "DAY", brevoTemplateId: "", template: "" };
}

export function FlowForm({
  initial,
  sites,
  triggers,
  variables,
}: {
  initial: FlowFormInitial | null;
  sites: SiteOption[];
  triggers: TriggerOpt[];
  variables: VarDef[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [name, setName] = useState(initial?.name ?? "");
  const [triggerType, setTriggerType] = useState(initial?.triggerType ?? triggers[0]?.type ?? "");
  const [siteIds, setSiteIds] = useState<string[]>(initial?.siteIds ?? []);
  const [steps, setSteps] = useState<StepDraft[]>(initial?.steps.map(toDraft) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const dto = useMemo(
    () => ({
      name,
      siteIds,
      triggerType,
      // Включение — отдельным действием в списке: новая цепочка всегда сохраняется выключенной,
      // а у существующей форма не должна незаметно менять этот флаг.
      active: initial?.active ?? false,
      steps: steps.map(toDTO),
    }),
    [name, siteIds, triggerType, steps, initial?.active]
  );

  const clientError = useMemo(
    () => validateFlow({ ...dto, steps: dto.steps.map((s, i) => ({ ...s, position: i + 1 })) }),
    [dto]
  );

  const selectedTrigger = triggers.find((t) => t.type === triggerType);

  function patch(index: number, patchValue: Partial<StepDraft>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patchValue } : s)));
  }

  function move(index: number, delta: number) {
    setSteps((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function submit() {
    setError(null);
    setWarning(null);
    if (clientError) {
      setError(clientError);
      return;
    }
    start(async () => {
      const res = initial ? await updateFlow(initial.id, dto) : await createFlow(dto);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.warning) setWarning(res.warning);
      router.push("/dashboard/automations/flows");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Название</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например: Просьба об отзыве"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Событие запуска</label>
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {triggers.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
              {selectedTrigger && <p className="mt-1 text-[11px] text-slate-500">{selectedTrigger.description}</p>}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Магазины</label>
            <SiteMultiSelect sites={sites} selected={siteIds} onChange={setSiteIds} />
            <p className="mt-1 text-[11px] text-slate-500">
              Цепочка запускается для заказов выбранных магазинов. Отдельный запуск создаётся на каждый заказ.
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">Шаги</h2>
              <p className="text-[11px] text-slate-500">Выполняются сверху вниз, по одному. Порядок меняется стрелками.</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {(["WAIT", "EMAIL", "SMS"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSteps((prev) => [...prev, emptyStep(t)])}
                  className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                >
                  + {FLOW_STEP_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {steps.length === 0 && (
            <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-400">
              Шагов пока нет. Добавьте первый шаг цепочки.
            </p>
          )}

          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
                    {i + 1}
                  </span>

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] font-medium text-slate-600">
                        {FLOW_STEP_TYPE_LABELS[s.type]}
                      </span>
                      {i === steps.length - 1 && s.type === "WAIT" && (
                        <span className="text-[11px] text-amber-600">Последним шагом не может быть ожидание</span>
                      )}
                    </div>

                    {s.type === "WAIT" && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-slate-600">Ждать</span>
                        <input
                          type="number"
                          min={1}
                          value={s.waitAmount}
                          onChange={(e) => patch(i, { waitAmount: e.target.value })}
                          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
                        />
                        <select
                          value={s.waitUnit}
                          onChange={(e) => patch(i, { waitUnit: e.target.value as FlowWaitUnit })}
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                        >
                          {FLOW_WAIT_UNITS.map((u) => (
                            <option key={u} value={u}>
                              {WAIT_UNIT_LABELS[u]}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {s.type === "EMAIL" && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-slate-600">Brevo Template ID</span>
                        <input
                          type="number"
                          min={1}
                          value={s.brevoTemplateId}
                          onChange={(e) => patch(i, { brevoTemplateId: e.target.value })}
                          placeholder="напр. 12"
                          className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
                        />
                        <span className="text-[11px] text-slate-500">
                          Отправитель и домен берутся из настроек Email магазина.
                        </span>
                      </div>
                    )}

                    {s.type === "SMS" && (
                      <div className="space-y-1">
                        <textarea
                          rows={3}
                          value={s.template}
                          onChange={(e) => patch(i, { template: e.target.value })}
                          placeholder="Текст SMS. Доступны переменные вида {{order_number}}"
                          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                        />
                        <p className="text-[11px] text-slate-500">
                          Переменные: {variables.map((v) => `{{${v.key}}}`).join(", ")}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      aria-label="Переместить выше"
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={i === steps.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="Переместить ниже"
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
                      aria-label="Удалить шаг"
                      className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      {(error || clientError) && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error ?? clientError}</p>
      )}
      {warning && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">{warning}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending || !!clientError} onClick={submit}>
          {pending ? "Сохранение…" : initial ? "Сохранить" : "Создать цепочку"}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => router.push("/dashboard/automations/flows")}>
          Отмена
        </Button>
        {!initial && <span className="text-[11px] text-slate-500">Новая цепочка создаётся выключенной.</span>}
      </div>
    </div>
  );
}
