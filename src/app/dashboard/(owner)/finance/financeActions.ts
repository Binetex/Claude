"use server";
/**
 * Финансовые действия владельца. Каждое начинается с requireRole("OWNER") — на layout
 * не полагаемся: server action вызывается по своему пути и обязан защищаться сам.
 *
 * floristId сюда приходит из URL, и это допустимо ТОЛЬКО потому, что владелец имеет право
 * на всех флористов. В кабинете флориста ни одно действие floristId не принимает.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { usdToCents, CentsParseError } from "@/lib/cents";
import { LedgerError, LedgerRuleError, reverseEntry } from "@/modules/finance/ledger";
import { recordPayment, recordAdjustment, previewPayment, type AdjustmentKind } from "@/modules/finance/payouts";
import { accrueOrder } from "@/modules/finance/accrual";
import type { LedgerDirection } from "@/generated/prisma/enums";

export type ActionResult = { ok?: true; message?: string; error?: string; needsConfirmation?: boolean };

/** Единый разбор доменных ошибок: пользователю — понятный текст, а не стектрейс. */
function toError(err: unknown): ActionResult {
  if (err instanceof LedgerError) {
    return { error: err.message, needsConfirmation: err.reason === "overpayment_requires_confirmation" };
  }
  if (err instanceof LedgerRuleError || err instanceof CentsParseError) return { error: err.message };
  console.error("[finance] action failed:", err);
  return { error: "Не удалось выполнить операцию." };
}

/**
 * Дата операции. Пустая строка — сегодня. Разбираем как UTC-полночь календарного дня:
 * ledger оперирует бизнес-датами, а не моментами времени, и локальная полночь браузера
 * уехала бы на сутки.
 */
function parseEffectiveDate(input: string | undefined): Date {
  const raw = input?.trim();
  if (!raw) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new LedgerError("bad_date", "Дата должна быть в формате ГГГГ-ММ-ДД.");
  return new Date(`${raw}T00:00:00.000Z`);
}

function revalidateFinance(floristId: string) {
  revalidatePath("/dashboard/finance/florists");
  revalidatePath(`/dashboard/finance/florists/${floristId}`);
  revalidatePath("/dashboard/finance/review");
  revalidatePath("/dashboard/f/finance");
}

/** Предпросмотр: уводит ли выплата баланс в минус. Форма спрашивает до отправки. */
export async function ownerPreviewPayment(floristId: string, amount: string): Promise<
  { ok: true; outstandingAfterCents: number; requiresConfirmation: boolean } | { error: string }
> {
  await requireRole("OWNER");
  try {
    const cents = usdToCents(amount);
    if (cents == null || cents <= 0) return { error: "Укажите сумму больше нуля." };
    const preview = await previewPayment(floristId, cents);
    return { ok: true, outstandingAfterCents: preview.outstandingAfterCents, requiresConfirmation: preview.requiresConfirmation };
  } catch (err) {
    const r = toError(err);
    return { error: r.error ?? "Не удалось посчитать." };
  }
}

export async function ownerRecordPayment(formData: FormData): Promise<ActionResult> {
  const user = await requireRole("OWNER");
  const floristId = String(formData.get("floristId") ?? "");
  if (!floristId) return { error: "Не выбран флорист." };

  try {
    const cents = usdToCents(String(formData.get("amount") ?? ""));
    if (cents == null || cents <= 0) return { error: "Укажите сумму больше нуля." };

    await recordPayment({
      floristId,
      amountCents: cents,
      effectiveDate: parseEffectiveDate(String(formData.get("date") ?? "")),
      comment: String(formData.get("comment") ?? "").trim() || null,
      method: String(formData.get("method") ?? "").trim() || null,
      reference: String(formData.get("reference") ?? "").trim() || null,
      // Токен формы: двойная отправка одной и той же выплаты не создаёт две записи.
      token: String(formData.get("token") ?? ""),
      confirmOverpayment: formData.get("confirmOverpayment") === "on",
      actor: { userId: user.id, role: user.role },
    });
    revalidateFinance(floristId);
    return { ok: true, message: "Выплата записана." };
  } catch (err) {
    return toError(err);
  }
}

export async function ownerRecordAdjustment(formData: FormData): Promise<ActionResult> {
  const user = await requireRole("OWNER");
  const floristId = String(formData.get("floristId") ?? "");
  if (!floristId) return { error: "Не выбран флорист." };

  const kind = String(formData.get("kind") ?? "") as AdjustmentKind;
  if (!["BONUS", "DEDUCTION", "MANUAL_ADJUSTMENT"].includes(kind)) return { error: "Неизвестный тип операции." };

  try {
    const cents = usdToCents(String(formData.get("amount") ?? ""));
    if (cents == null || cents <= 0) return { error: "Укажите сумму больше нуля." };

    await recordAdjustment({
      floristId,
      kind,
      amountCents: cents,
      effectiveDate: parseEffectiveDate(String(formData.get("date") ?? "")),
      description: String(formData.get("description") ?? "").trim(),
      comment: String(formData.get("comment") ?? "").trim() || null,
      orderId: String(formData.get("orderId") ?? "").trim() || null,
      direction: (String(formData.get("direction") ?? "") || undefined) as LedgerDirection | undefined,
      token: String(formData.get("token") ?? ""),
      actor: { userId: user.id, role: user.role },
    });
    revalidateFinance(floristId);
    return { ok: true, message: "Операция записана." };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Отмена операции. Опубликованная запись не редактируется — создаётся зеркальная.
 * Комментарий обязателен: отмена без причины нечитаема через полгода.
 */
export async function ownerReverseEntry(formData: FormData): Promise<ActionResult> {
  const user = await requireRole("OWNER");
  const entryId = String(formData.get("entryId") ?? "");
  const floristId = String(formData.get("floristId") ?? "");
  const comment = String(formData.get("comment") ?? "").trim();
  if (!entryId) return { error: "Операция не выбрана." };
  if (!comment) return { error: "Укажите причину отмены." };

  try {
    await reverseEntry({ entryId, comment, actor: { userId: user.id, role: user.role } });
    revalidateFinance(floristId);
    return { ok: true, message: "Операция отменена сторнирующей записью." };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Ручной запуск начисления по заказу из очереди разбора — после того, как владелец
 * назначил флориста или задал цену. Идемпотентно: повтор вернёт «уже начислено».
 */
export async function ownerAccrueOrder(orderId: string): Promise<ActionResult> {
  const user = await requireRole("OWNER");
  try {
    const outcome = await accrueOrder(orderId, { userId: user.id, role: user.role });
    revalidatePath("/dashboard/finance/review");
    revalidatePath("/dashboard/finance/florists");
    switch (outcome.status) {
      case "CREATED":
        return { ok: true, message: `Начислено ${(outcome.amountCents / 100).toFixed(2)}.` };
      case "ALREADY_EXISTS":
        return { ok: true, message: "По этому заказу уже начислено." };
      default:
        return { error: skipMessage(outcome.reason) };
    }
  } catch (err) {
    return toError(err);
  }
}

function skipMessage(reason: string): string {
  switch (reason) {
    case "ACCRUAL_DISABLED":
      return "Начисления выключены (FINANCE_ACCRUAL_ENABLED / FINANCE_ACCRUAL_START_DATE).";
    case "BEFORE_START_DATE":
      return "Заказ доставлен раньше даты старта начислений.";
    case "NOT_DELIVERED":
      return "Заказ ещё не доставлен.";
    case "NO_FLORIST":
      return "У заказа нет флориста — назначьте исполнителя.";
    case "NO_FINANCE_PROFILE":
      return "У флориста не задан финансовый профиль.";
    case "PRIMARY_MODEL_STAGE3":
      return "Основной флорист получает долю за период — это следующий этап.";
    case "PROFILE_SITE_MISMATCH":
      return "Профиль флориста не распространяется на магазин заказа.";
    case "FLORIST_PRICE_MISSING":
      return "Цена флориста не задана — укажите сумму вручную в карточке заказа.";
    default:
      return "Начисление не создано.";
  }
}
