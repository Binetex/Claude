"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { validatePickupLocation } from "@/integrations/delivery/burq/pickupValidation";
import { rescheduleFloristWaitingOrders } from "@/integrations/delivery/burq/scheduleService";

type FormState = { error?: string; ok?: boolean; message?: string } | null;

const ERROR_LABELS: Record<string, string> = {
  location_name_required: "укажите название точки",
  contact_name_required: "укажите контактное лицо",
  contact_phone_invalid: "телефон в формате E.164 (+1…)",
  address_line_required: "укажите адрес",
  city_required: "укажите город",
  state_invalid: "штат — 2 буквы (напр. CA)",
  zip_invalid: "ZIP — 5 цифр или ZIP+4",
  pickup_inactive: "точка отключена",
};

/**
 * Настройка pickup-локации флориста (FloristPickupLocation). Обязательна для авто-создания
 * Burq draft: pickup берётся ТОЛЬКО отсюда, fallback на Site/Google/customer запрещён.
 * Телефон нормализуется в E.164; адрес/штат/ZIP валидируются (US).
 */
export async function ownerSavePickupLocation(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");

  const floristId = String(formData.get("floristId") ?? "");
  if (!floristId) return { error: "Не указан флорист." };
  const contactPhone = normalizePhone(String(formData.get("contactPhone") ?? ""));
  const input = {
    locationName: String(formData.get("locationName") ?? "").trim(),
    contactName: String(formData.get("contactName") ?? "").trim(),
    contactPhone,
    addressLine: String(formData.get("addressLine") ?? "").trim(),
    apartmentOrSuite: String(formData.get("apartmentOrSuite") ?? "").trim() || null,
    city: String(formData.get("city") ?? "").trim(),
    state: String(formData.get("state") ?? "").trim().toUpperCase(),
    zip: String(formData.get("zip") ?? "").trim(),
    courierInstructions: String(formData.get("courierInstructions") ?? "").trim() || null,
    isActive: String(formData.get("isActive") ?? "1") === "1",
  };

  const validation = validatePickupLocation(input);
  if (!validation.valid) {
    const parts = validation.errors.map((e) => ERROR_LABELS[e] ?? e);
    return { error: `Проверьте поля: ${parts.join("; ")}.` };
  }

  await prisma.floristPickupLocation.upsert({
    where: { floristId },
    create: { floristId, ...input },
    update: input,
  });

  // Настройка/активация pickup разблокирует ждущие заказы этого флориста (WAITING_FOR_FLORIST).
  let rescheduled = 0;
  if (input.isActive) {
    try {
      rescheduled = await rescheduleFloristWaitingOrders(prisma, floristId);
    } catch (err) {
      console.error(`[burq] reschedule florist waiting orders failed (${floristId}):`, err instanceof Error ? err.message : String(err));
    }
  }

  revalidatePath("/dashboard/florists");
  return { ok: true, message: rescheduled ? `Точка забора сохранена. Перепланировано заказов: ${rescheduled}.` : "Точка забора сохранена." };
}
