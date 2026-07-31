"use server";
/**
 * Server actions Marketing Flows. Правила валидации живут в чистом модуле
 * (modules/automations/flows/validation) — форма и сервер проверяют ОДНО и то же.
 *
 * Цепочки всегда создаются выключенными; включение — отдельным действием, осознанно.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { validateFlow, type FlowStepInput, type FlowStepTypeInput, type FlowWaitUnit } from "@/modules/automations/flows/validation";

/** Шаг из формы. `id` есть только у уже сохранённых шагов (нужен, чтобы не терять историю). */
export type FlowStepDTO = {
  id?: string | null;
  type: FlowStepTypeInput;
  waitAmount: number | null;
  waitUnit: FlowWaitUnit | null;
  brevoTemplateId: number | null;
  template: string | null;
};

export type FlowDTO = {
  name: string;
  siteIds: string[];
  triggerType: string;
  active: boolean;
  steps: FlowStepDTO[];
};

export type FlowActionResult = { ok?: true; id?: string; error?: string; warning?: string };

/** Позиции всегда переназначаются по порядку в форме: 1..N, без дыр. */
function withPositions(steps: FlowStepDTO[]): (FlowStepInput & { id?: string | null })[] {
  return steps.map((s, i) => ({
    id: s.id ?? null,
    position: i + 1,
    type: s.type,
    waitAmount: s.waitAmount,
    waitUnit: s.waitUnit,
    brevoTemplateId: s.brevoTemplateId,
    template: s.template,
  }));
}

/** Поля шага для записи в БД: у каждого типа заполнены только свои. */
function stepData(s: FlowStepInput) {
  return {
    type: s.type,
    waitAmount: s.type === "WAIT" ? s.waitAmount : null,
    waitUnit: s.type === "WAIT" ? s.waitUnit : null,
    brevoTemplateId: s.type === "EMAIL" ? s.brevoTemplateId : null,
    template: s.type === "SMS" ? (s.template?.trim() ?? null) : null,
  };
}

async function resolveSiteIds(siteIds: string[]): Promise<{ ids: string[] } | { error: string }> {
  const unique = [...new Set(siteIds.filter(Boolean))];
  const found = await prisma.site.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (found.length !== unique.length) return { error: "Один из выбранных магазинов не найден." };
  return { ids: unique };
}

/**
 * Мягкое предупреждение: SMS-шаг использует {{review_url}}, но у магазина ссылка не задана —
 * такое сообщение движок не отправит (как и у одиночных правил).
 */
async function reviewUrlWarning(siteIds: string[], steps: FlowStepInput[]): Promise<string | undefined> {
  const usesReviewUrl = steps.some((s) => s.type === "SMS" && /\{\{\s*review_url\s*\}\}/.test(s.template ?? ""));
  if (!usesReviewUrl) return undefined;
  const sites = await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { name: true, reviewUrl: true } });
  const missing = sites.filter((s) => !s.reviewUrl).map((s) => s.name);
  if (missing.length === 0) return undefined;
  return `SMS-шаг использует {{review_url}}, но ссылка на отзыв не задана у магазинов: ${missing.join(", ")} — такие сообщения отправлены не будут.`;
}

export async function createFlow(input: FlowDTO): Promise<FlowActionResult> {
  await requireRole("OWNER");
  const steps = withPositions(input.steps ?? []);
  const err = validateFlow({ name: input.name, siteIds: input.siteIds, triggerType: input.triggerType, active: input.active, steps });
  if (err) return { error: err };
  const resolved = await resolveSiteIds(input.siteIds);
  if ("error" in resolved) return { error: resolved.error };

  const created = await prisma.automationFlow.create({
    data: {
      name: input.name.trim(),
      active: !!input.active,
      triggerType: input.triggerType,
      sites: { create: resolved.ids.map((siteId) => ({ siteId })) },
      steps: { create: steps.map((s) => ({ position: s.position, ...stepData(s) })) },
    },
    select: { id: true },
  });
  revalidatePath("/dashboard/automations/flows");
  return { ok: true, id: created.id, warning: await reviewUrlWarning(resolved.ids, steps) };
}

export async function updateFlow(id: string, input: FlowDTO): Promise<FlowActionResult> {
  await requireRole("OWNER");
  const steps = withPositions(input.steps ?? []);
  const err = validateFlow({ name: input.name, siteIds: input.siteIds, triggerType: input.triggerType, active: input.active, steps });
  if (err) return { error: err };

  const existing = await prisma.automationFlow.findUnique({
    where: { id },
    select: {
      id: true,
      deletedAt: true,
      sites: { select: { siteId: true } },
      steps: { select: { id: true, _count: { select: { runSteps: true } } } },
    },
  });
  if (!existing || existing.deletedAt) return { error: "Цепочка не найдена." };

  const resolved = await resolveSiteIds(input.siteIds);
  if ("error" in resolved) return { error: resolved.error };

  const currentSites = new Set(existing.sites.map((s) => s.siteId));
  const nextSites = new Set(resolved.ids);
  const sitesToAdd = resolved.ids.filter((s) => !currentSites.has(s));
  const sitesToRemove = [...currentSites].filter((s) => !nextSites.has(s));

  const keptIds = new Set(steps.map((s) => s.id).filter((v): v is string => !!v));
  const removed = existing.steps.filter((s) => !keptIds.has(s.id));

  await prisma.$transaction(async (tx) => {
    // Позиции уникальны в пределах цепочки, поэтому переупорядочивание идёт в два прохода:
    // сперва уводим ВСЕ существующие шаги во временные отрицательные позиции, затем
    // расставляем финальные. Иначе обмен местами двух соседей упирался бы в unique-индекс.
    for (let i = 0; i < existing.steps.length; i++) {
      await tx.automationFlowStep.update({ where: { id: existing.steps[i].id }, data: { position: -(i + 1) } });
    }

    for (const s of steps) {
      if (s.id && keptIds.has(s.id)) {
        await tx.automationFlowStep.update({ where: { id: s.id }, data: { position: s.position, ...stepData(s) } });
      } else {
        await tx.automationFlowStep.create({ data: { flowId: id, position: s.position, ...stepData(s) } });
      }
    }

    for (const r of removed) {
      // Шаг с историей выполнения физически не удаляем: на него ссылаются записи run'ов.
      // Он остаётся на временной отрицательной позиции — движок пропускает удалённые шаги,
      // а история продолжает показывать снимок позиции на момент выполнения.
      if (r._count.runSteps > 0) {
        await tx.automationFlowStep.update({ where: { id: r.id }, data: { deletedAt: new Date() } });
      } else {
        await tx.automationFlowStep.delete({ where: { id: r.id } });
      }
    }

    await tx.automationFlow.update({
      where: { id },
      data: {
        name: input.name.trim(),
        active: !!input.active,
        triggerType: input.triggerType,
        sites: {
          deleteMany: sitesToRemove.length ? { siteId: { in: sitesToRemove } } : undefined,
          create: sitesToAdd.map((siteId) => ({ siteId })),
        },
      },
    });
  });

  revalidatePath("/dashboard/automations/flows");
  revalidatePath(`/dashboard/automations/flows/${id}`);
  return { ok: true, id, warning: await reviewUrlWarning(resolved.ids, steps) };
}

export async function toggleFlow(id: string, active: boolean): Promise<FlowActionResult> {
  await requireRole("OWNER");
  const existing = await prisma.automationFlow.findUnique({
    where: { id },
    select: { deletedAt: true, _count: { select: { steps: true } } },
  });
  if (!existing || existing.deletedAt) return { error: "Цепочка не найдена." };
  if (active && existing._count.steps === 0) return { error: "Нельзя включить цепочку без шагов." };
  await prisma.automationFlow.update({ where: { id }, data: { active: !!active } });
  revalidatePath("/dashboard/automations/flows");
  return { ok: true };
}

/** Удаление: физическое ТОЛЬКО если истории нет; иначе soft-delete (run'ы сохраняются). */
export async function deleteFlow(id: string): Promise<FlowActionResult> {
  await requireRole("OWNER");
  const existing = await prisma.automationFlow.findUnique({
    where: { id },
    select: { id: true, _count: { select: { runs: true } } },
  });
  if (!existing) return { error: "Цепочка не найдена." };

  if (existing._count.runs === 0) {
    await prisma.automationFlow.delete({ where: { id } }); // шаги и связи магазинов — каскадом
  } else {
    // Активные run'ы остановятся при выполнении следующего шага (flow_deleted).
    await prisma.automationFlow.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
  }
  revalidatePath("/dashboard/automations/flows");
  return { ok: true };
}
