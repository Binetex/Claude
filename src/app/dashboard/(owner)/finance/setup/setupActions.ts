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
import {
  FinanceFixError,
  confirmBurqDeliveryCosts,
  fixConsumablesRate,
  fixDailyFlowerExpense,
  fixOwnerTaxPolicy,
  fixSiteFeeModel,
  previewBurqDeliveryConfirmation,
} from "@/modules/finance/fix";
import { FinanceSettingsError } from "@/modules/finance/settings";
import { detectFinanceIssues } from "@/modules/finance/issues";
import { setFinanceProfile } from "@/modules/finance/profile";
import { primaryShareDays, recomputeDay } from "@/modules/finance/dayFinance";
import { todayStrInTz } from "@/lib/tz";

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
    // «Сегодня» — по календарю магазина, а не по UTC: полночь UTC наступает в
    // Лос-Анджелесе в 17:00, и запись, сделанная вечером, датировалась следующим днём.
    return new Date(`${todayStrInTz(null)}T00:00:00.000Z`);
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
  // Обзор считается из тех же данных — без этого он остался бы со старой прибылью.
  revalidatePath("/dashboard/finance", "layout");
}

function done(message: string, r: { days: number; detector: { autoResolved: number } }): SetupResult {
  revalidateSetup();
  const parts = [message];
  if (r.days > 0) parts.push(`пересчитано дней: ${r.days}`);
  if (r.detector.autoResolved > 0) parts.push(`закрыто проблем: ${r.detector.autoResolved}`);
  return { ok: true, message: parts.join(" · ") };
}

// ─────────────────────────── Исправления ───────────────────────────

export async function applyFeeModel(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixSiteFeeModel({
      siteId: String(formData.get("siteId") ?? ""),
      percentBp: percentToBp(formData.get("percent"), "Процент комиссии"),
      fixedCents: String(formData.get("fixed") ?? "").trim() ? requiredCents(formData.get("fixed"), "фиксированную часть") : 0,
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

export async function applyConsumablesRate(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await fixConsumablesRate({
      siteId: String(formData.get("siteId") ?? "").trim() || null,
      amountCents: requiredCents(formData.get("amount"), "ставку расходников"),
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
      issueId: String(formData.get("issueId") ?? "") || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    return done("Налоговая политика сохранена.", r);
  } catch (err) {
    return toError(err);
  }
}

// ───────── Массовое подтверждение доставки по суммам Burq ─────────

export type BulkDeliveryPreviewResult =
  | { ok: true; preview: Awaited<ReturnType<typeof previewBurqDeliveryConfirmation>> }
  | { error: string };

/** Что будет применено к выбранным заказам. Ничего не пишет. */
export async function previewBurqDelivery(orderIds: string[]): Promise<BulkDeliveryPreviewResult> {
  await requireRole("OWNER");
  try {
    return { ok: true, preview: await previewBurqDeliveryConfirmation(orderIds) };
  } catch (err) {
    const r = toError(err);
    return { error: r.error ?? "Не удалось посчитать." };
  }
}

/**
 * Применяет подтверждение. Список заказов приходит явным выбором владельца — ничего
 * не подставляется само, и заказы без суммы Burq в кандидаты не попадают в принципе.
 */
export async function applyBurqDelivery(orderIds: string[], comment?: string): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const r = await confirmBurqDeliveryCosts({
      orderIds,
      comment: comment?.trim() || null,
      actor: { userId: user.id, role: user.role },
    });
    revalidatePath("/dashboard/finance/setup/delivery");
    return done(`Подтверждено заказов: ${r.confirmed}.`, r);
  } catch (err) {
    return toError(err);
  }
}

/**
 * Задаёт долю основного флориста новым периодом профиля с указанной даты.
 *
 * Отдельного механизма для процента нет специально: доля — часть финансового профиля, а он
 * effective-dated. Прежний период остаётся и продолжает объяснять то, что по нему посчитано.
 */
export async function applyPrimarySharePercent(formData: FormData): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const floristId = String(formData.get("floristId") ?? "");
    if (!floristId) return { error: "Не выбран флорист." };

    await setFinanceProfile({
      floristId,
      model: "PRIMARY",
      effectiveFrom: parseDay(String(formData.get("effectiveFrom") ?? "")),
      sharePercentBp: percentToBp(formData.get("percent"), "Доля основного флориста"),
      comment: String(formData.get("comment") ?? "").trim() || null,
      actor: { userId: user.id, role: user.role },
    });

    revalidateSetup();
    revalidatePath("/dashboard/finance/florists", "layout");
    return { ok: true, message: "Доля основного флориста сохранена." };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Ручной пересчёт всех дней с даты запуска. Денег не трогает: заработок выводится из
 * итогов дней, а выплата остаётся ручной операцией PAYMENT.
 */
export async function recomputePrimaryShare(): Promise<SetupResult> {
  const user = await requireRole("OWNER");
  try {
    const plan = await primaryShareDays();
    if (!plan) return { error: "Не задана дата запуска расчёта, профиль или доля основного флориста." };

    let complete = 0;
    for (const day of plan.days) {
      const r = await recomputeDay(plan.profileId, day, { userId: user.id });
      if (r?.complete) complete++;
    }

    revalidatePath("/dashboard/finance/florists", "layout");
    revalidatePath("/dashboard/finance/florists");
  // Обзор считается из тех же данных — без этого он остался бы со старой прибылью.
  revalidatePath("/dashboard/finance", "layout");
    return {
      ok: true,
      message: `Дней: ${plan.days.length} · посчитано целиком: ${complete} · не хватает данных: ${plan.days.length - complete}`,
    };
  } catch (err) {
    return toError(err);
  }
}

export async function rescanFinanceIssues(): Promise<SetupResult> {
  await requireRole("OWNER");
  try {
    const r = await detectFinanceIssues();
    revalidateSetup();
    return {
      ok: true,
      message: `Новых: ${r.opened} · переоткрыто: ${r.reopened} · обновлено: ${r.updated} · закрыто: ${r.autoResolved}`,
    };
  } catch (err) {
    return toError(err);
  }
}
