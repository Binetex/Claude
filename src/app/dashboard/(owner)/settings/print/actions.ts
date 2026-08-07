"use server";
/**
 * Сохранение и сброс настроек печати. OWNER-only.
 *
 * Значения приводятся к допустимым на сервере (`savePrintSettings` → `clampSettings`), а не
 * только атрибутами input: форму можно обойти, а сломанная геометрия печатается молча —
 * заметят её уже на бумаге.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { PRINT_FIELDS, type PrintLayout, type PrintSettings } from "@/modules/print/settings";
import { resetPrintSettings, savePrintSettings } from "@/modules/print/settingsStore";

export type PrintSettingsResult = { error?: string; message?: string };

function parseLayout(raw: FormDataEntryValue | null): PrintLayout {
  const v = String(raw ?? "");
  if (v !== "wide" && v !== "tall") throw new Error("bad_layout");
  return v;
}

export async function savePrintSettingsAction(
  _prev: PrintSettingsResult,
  formData: FormData
): Promise<PrintSettingsResult> {
  const user = await requireRole("OWNER");
  let layout: PrintLayout;
  try {
    layout = parseLayout(formData.get("layout"));
  } catch {
    return { error: "Неизвестная раскладка." };
  }

  const raw = {} as PrintSettings;
  for (const key of PRINT_FIELDS) {
    const value = Number(String(formData.get(key) ?? "").trim().replace(",", "."));
    if (!Number.isFinite(value)) return { error: "Все поля — целые числа." };
    raw[key] = value;
  }

  await savePrintSettings(layout, raw, user.id);
  revalidatePath("/dashboard/settings/print");
  return { message: "Сохранено. Значения вне допустимых границ подрезаны." };
}

export async function resetPrintSettingsAction(
  _prev: PrintSettingsResult,
  formData: FormData
): Promise<PrintSettingsResult> {
  await requireRole("OWNER");
  try {
    await resetPrintSettings(parseLayout(formData.get("layout")));
  } catch {
    return { error: "Неизвестная раскладка." };
  }
  revalidatePath("/dashboard/settings/print");
  return { message: "Возвращены значения по умолчанию." };
}
