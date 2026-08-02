"use server";
/**
 * Исправление и удаление записей настроек расчёта. OWNER-only.
 *
 * Создание НОВОЙ ставки живёт отдельно (setupActions.applyConsumablesRate и соседние):
 * это разные по смыслу операции, и путать их в одном действии нельзя — одна закрывает
 * период и оставляет прошлое как было, другая переписывает уже посчитанное.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import {
  correctSetting,
  deleteSetting,
  previewSettingChange,
  SettingsAdminError,
  type SettingEntity,
  type SettingPreview,
  type SettingValues,
} from "@/modules/finance/settingsAdmin";

export type AdminActionResult = { error?: string; message?: string };

function fail(e: unknown): AdminActionResult {
  if (e instanceof SettingsAdminError) return { error: e.message };
  throw e;
}

function refresh(): void {
  revalidatePath("/dashboard/finance/settings");
  revalidatePath("/dashboard/finance/share");
  revalidatePath("/dashboard/finance/setup");
}

function parseEntity(raw: FormDataEntryValue | null): SettingEntity {
  const v = String(raw ?? "");
  if (v === "CONSUMABLES_RATE" || v === "FEE_MODEL" || v === "TAX_POLICY") return v;
  throw new SettingsAdminError("bad_entity", "Неизвестная настройка.");
}

function parseDay(raw: FormDataEntryValue | null): Date {
  const v = String(raw ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new SettingsAdminError("bad_day", "Дата должна быть в формате ГГГГ-ММ-ДД.");
  return new Date(`${v}T00:00:00.000Z`);
}

/** Денежная строка формы в целые центы. */
function cents(raw: FormDataEntryValue | null, what: string): number {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) throw new SettingsAdminError("bad_amount", `Введите ${what}.`);
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new SettingsAdminError("bad_amount", `${what}: неотрицательное число.`);
  return Math.round(value * 100);
}

/** Процент формы в базисные пункты: 2.9 → 290. */
function bp(raw: FormDataEntryValue | null, what: string): number {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) throw new SettingsAdminError("bad_bp", `Введите ${what}.`);
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new SettingsAdminError("bad_bp", `${what}: число от 0 до 100.`);
  }
  return Math.round(value * 100);
}

function parseValues(entity: SettingEntity, fd: FormData): SettingValues {
  if (entity === "CONSUMABLES_RATE") return { entity, amountCents: cents(fd.get("amount"), "сумму") };
  if (entity === "FEE_MODEL") {
    return { entity, percentBp: bp(fd.get("percent"), "процент"), fixedCents: cents(fd.get("fixed"), "фиксированную часть") };
  }
  return { entity, actualShareBp: bp(fd.get("share"), "долю") };
}

export async function correctSettingAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireRole("OWNER");
  try {
    const entity = parseEntity(formData.get("entity"));
    const r = await correctSetting({
      entity,
      id: String(formData.get("id") ?? ""),
      values: parseValues(entity, formData),
      effectiveFrom: parseDay(formData.get("effectiveFrom")),
      reason: String(formData.get("reason") ?? ""),
      actor: { userId: user.id, role: user.role },
    });
    refresh();
    const ledger =
      r.share.corrected > 0
        ? ` Начислений пересчитано: ${r.share.corrected}.`
        : r.share.unchanged > 0
          ? " Начисления не изменились."
          : "";
    return { message: `Исправлено. Дней затронуто: ${r.affectedDays}, ревизий снимков: ${r.republished}.${ledger}` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSettingAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await deleteSetting({
      entity: parseEntity(formData.get("entity")),
      id: String(formData.get("id") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      actor: { userId: user.id, role: user.role },
    });
    refresh();
    const ledger = r.share.corrected > 0 ? ` Начислений пересчитано: ${r.share.corrected}.` : "";
    return { message: `Запись удалена. Дней затронуто: ${r.affectedDays}, ревизий снимков: ${r.republished}.${ledger}` };
  } catch (e) {
    return fail(e);
  }
}

/** Предпросмотр: ничего не пишет. Нужен до подтверждения исправления или удаления. */
export async function previewSettingAction(input: {
  entity: SettingEntity;
  id: string;
  op: "CORRECT" | "DELETE";
  amount?: string;
  percent?: string;
  fixed?: string;
  share?: string;
  effectiveFrom?: string;
}): Promise<{ error?: string; preview?: SettingPreview }> {
  await requireRole("OWNER");
  try {
    const fd = new FormData();
    if (input.amount != null) fd.set("amount", input.amount);
    if (input.percent != null) fd.set("percent", input.percent);
    if (input.fixed != null) fd.set("fixed", input.fixed);
    if (input.share != null) fd.set("share", input.share);

    return {
      preview: await previewSettingChange({
        entity: input.entity,
        id: input.id,
        op: input.op,
        values: input.op === "CORRECT" ? parseValues(input.entity, fd) : undefined,
        effectiveFrom: input.op === "CORRECT" && input.effectiveFrom ? parseDay(input.effectiveFrom) : undefined,
      }),
    };
  } catch (e) {
    const r = fail(e);
    return { error: r.error };
  }
}
