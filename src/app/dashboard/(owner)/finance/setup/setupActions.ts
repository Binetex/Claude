"use server";
/**
 * Действия Finance Setup Assistant. Каждое начинается с requireRole("OWNER") — на layout
 * не полагаемся: server action вызывается по своему пути и обязан защищаться сам.
 *
 * Ни одно действие не создаёт LedgerEntry: ассистент пишет только входные данные расчёта.
 * Предпросмотр отделён от записи и не пишет ничего.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { usdToCents, CentsParseError } from "@/lib/cents";
import { prisma } from "@/lib/db";
import { FinanceFixError, dismissIssue, fixConsumablesRate, fixDailyFlowerExpense, fixDeliveryActualCost, fixOwnerTaxPolicy, fixSiteFeeModel, fixVaseLink, fixVasePurchaseCost } from "@/modules/finance/fix";
import { FinanceSettingsError } from "@/modules/finance/settings";
import { detectFinanceIssues } from "@/modules/finance/issues";
import { previewDay, suggestDailyExpenseCents, suggestDeliveryCostCents } from "@/modules/finance/preview";
import type { DayPreview } from "@/modules/finance/preview";

export type SetupResult = { ok?: true; message?: string; error?: string };

function toError(err: unknown): SetupResult {
  if (err instanceof FinanceFixError || err instanceof FinanceSettingsError || err instanceof CentsParseError) {
    return { error: err.message };
  }
  console.error("[finance-setup] action failed:", err);
  return { error: "Не удалось применить исправление." };
}

/** Дата из формы. Пустая строка — сегодня. Разбор строгий: бизнес-дата, а не момент. */
function parseDay(input: string | undefined): Date {
  const raw = input?.trim();
  if (!raw) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new FinanceFixError("bad_date", "Дата должна быть в формате ГГГГ-ММ-ДД.");
  return new Date(`${raw}T00:00:00.000Z`);
}

function requiredCents(value: FormDataEntryValue | null, what: string): number {
  const cents = usdToCents(String(value ?? ""));
  if (cents == null) throw new FinanceFixError("bad_amount", `Укажите ${what}.`);
  return cents;
}

/** Процент из формы («2.9») в базисные пункты. */
function percentToBp(value: FormDataEntryValue | null, what: string): number {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new FinanceFixError("bad_percent", `${what} — число от 0 до 100.`);
  const bp = Math.round(Number(raw) * 100);
  if (bp < 0 || bp > 10000) throw new FinanceFixError("bad_percent", `${what} — число от 0 до 100.`);
  return bp;
}

function revalidateSetup() {
  revalidatePath("/dashboard/finance/setup");
  revalidatePath("/dashboard/finance/settings");
  revalidatePath("/dashboard/finance/florists");
}

function done(message: string, r: { republished: number; days: number; detector: { autoResolved: number } }): SetupResult {
  revalidateSetup();
  const parts = [message];
  if (r.days > 0) parts.push(`пересчитано дней: ${r.days}, новых ревизий: ${r.republished}`);
  if (r.detector.autoResolved > 0) parts.push(`закрыто проблем: ${r.detector.autoResolved}`);
  return { ok: true, message: parts.join(" · ") };
}

// ─────────────────────────── Предпросмотр ───────────────────────────

export type PreviewResult = { ok: true; preview: DayPreview | null } | { error: string };

/**
 * Эффект кандидатского значения. Ничего не пишет: считает тем же кодом, что и публикация,
 * поэтому показанное число совпадёт с тем, что запишется.
 */
export async function previewFix(input: {
  day: string;
  dailyExpenseUsd?: string;
  orderId?: string;
  deliveryUsd?: string;
  siteId?: string;
  feePercent?: string;
  feeFixedUsd?: string;
  consumablesUsd?: string;
  vaseGiftUsd?: string;
}): Promise<PreviewResult> {
  await requireRole("OWNER");
  try {
    const profile = await prisma.floristFinanceProfile.findFirst({
      where: { model: "PRIMARY", active: true, effectiveTo: null },
      select: { id: true },
    });
    if (!profile) return { error: "Не задан профиль основного флориста." };

    const overrides: Parameters<typeof previewDay>[2] = {};
    if (input.dailyExpenseUsd?.trim()) overrides.dailyExpenseCents = requiredCents(input.dailyExpenseUsd, "сумму");
    if (input.orderId && input.deliveryUsd?.trim()) {
      overrides.deliveryActualCentsByOrder = { [input.orderId]: requiredCents(input.deliveryUsd, "стоимость доставки") };
    }
    if (input.siteId && input.feePercent?.trim()) {
      overrides.feeModelBySite = {
        [input.siteId]: {
          percentBp: percentToBp(input.feePercent, "Процент комиссии"),
          fixedCents: input.feeFixedUsd?.trim() ? requiredCents(input.feeFixedUsd, "фиксированную часть") : 0,
        },
      };
    }
    if (input.siteId && input.consumablesUsd?.trim()) {
      overrides.consumablesCentsBySite = { [input.siteId]: requiredCents(input.consumablesUsd, "ставку") };
    }
    if (input.orderId && input.vaseGiftUsd?.trim()) {
      overrides.vaseGiftCostCentsByOrder = { [input.orderId]: requiredCents(input.vaseGiftUsd, "стоимость") };
    }

    return { ok: true, preview: await previewDay(profile.id, parseDay(input.day), overrides) };
  } catch (err) {
    const r = toError(err);
    return { error: r.error ?? "Не удалось посчитать." };
  }
}

/** Подсказки для карточек: оценка Burq и средняя дневная закупка. */
export async function getSuggestions(input: { orderId?: string; day?: string }): Promise<{
  deliveryCents?: number;
  deliverySource?: string;
  dailyExpenseCents?: number;
}> {
  await requireRole("OWNER");
  const out: { deliveryCents?: number; deliverySource?: string; dailyExpenseCents?: number } = {};

  if (input.orderId) {
    const suggestion = await suggestDeliveryCostCents(input.orderId);
    if (suggestion) {
      out.deliveryCents = suggestion.cents;
      out.deliverySource = suggestion.source;
    }
  }
  if (input.day) {
    const profile = await prisma.floristFinanceProfile.findFirst({
      where: { model: "PRIMARY", active: true, effectiveTo: null },
      select: { id: true },
    });
    if (profile) {
      const avg = await suggestDailyExpenseCents(profile.id, parseDay(input.day));
      if (avg != null) out.dailyExpenseCents = avg;
    }
  }
  return out;
}

// ─────────────────────────── Исправления ───────────────────────────

export async function applyDeliveryCost(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixDeliveryActualCost({
      orderId: String(formData.get("orderId") ?? ""),
      amountCents: requiredCents(formData.get("amount"), "стоимость доставки"),
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Стоимость доставки подтверждена.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function applyFeeModel(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixSiteFeeModel({
      siteId: String(formData.get("siteId") ?? ""),
      percentBp: percentToBp(formData.get("percent"), "Процент комиссии"),
      fixedCents: String(formData.get("fixed") ?? "").trim() ? requiredCents(formData.get("fixed"), "фиксированную часть") : 0,
      effectiveFrom: parseDay(String(formData.get("effectiveFrom") ?? "")),
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Модель комиссии сохранена.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function applyDailyFlowerExpense(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixDailyFlowerExpense({
      expenseDay: parseDay(String(formData.get("day") ?? "")),
      amountCents: requiredCents(formData.get("amount"), "сумму закупки"),
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Расход на цветы сохранён.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function applyVasePurchaseCost(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixVasePurchaseCost({
      variantId: String(formData.get("variantId") ?? ""),
      amountCents: requiredCents(formData.get("amount"), "закупочную стоимость"),
      effectiveFrom: parseDay(String(formData.get("effectiveFrom") ?? "")),
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Закупочная стоимость сохранена.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function applyVaseLink(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const vaseVariantId = String(formData.get("vaseVariantId") ?? "").trim();
    if (!vaseVariantId) return { error: "Выберите вазу." };
    const r = await fixVaseLink({
      variantId: String(formData.get("variantId") ?? ""),
      selection: { mode: "LINKED_VASE", vaseVariantId },
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Ваза связана с букетом.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function applyConsumablesRate(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixConsumablesRate({
      siteId: String(formData.get("siteId") ?? "").trim() || null,
      amountCents: requiredCents(formData.get("amount"), "ставку расходников"),
      effectiveFrom: parseDay(String(formData.get("effectiveFrom") ?? "")),
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Ставка расходников сохранена.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function applyOwnerTaxPolicy(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixOwnerTaxPolicy({
      siteId: String(formData.get("siteId") ?? "").trim() || null,
      actualShareBp: percentToBp(formData.get("percent"), "Доля налогового расхода"),
      effectiveFrom: parseDay(String(formData.get("effectiveFrom") ?? "")),
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Налоговая политика сохранена.", r);
  } catch (err) {
    return toError(err);
  }
}

export async function dismissFinanceIssue(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    await dismissIssue({
      issueId: String(formData.get("issueId") ?? ""),
      comment: String(formData.get("comment") ?? ""),
      actor: { userId: user.id, role: user.role },
    });
    revalidateSetup();
    return { ok: true, message: "Проблема закрыта без исправления." };
  } catch (err) {
    return toError(err);
  }
}

/** Ручной прогон детектора: владелец хочет обновить очередь прямо сейчас. */
export async function rescanFinanceIssues(): Promise<SetupResult> {
  await requireRole("OWNER");
  try {
    const r = await detectFinanceIssues();
    revalidateSetup();
    return {
      ok: true,
      message: `Найдено новых: ${r.opened} · обновлено: ${r.updated} · закрыто автоматически: ${r.autoResolved}`,
    };
  } catch (err) {
    return toError(err);
  }
}
