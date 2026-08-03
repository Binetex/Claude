"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { validatePickupLocation } from "@/integrations/delivery/burq/pickupValidation";
import { rescheduleFloristWaitingOrders } from "@/integrations/delivery/burq/scheduleService";
import { setPrimaryPickupLocation } from "@/modules/pickup/service";
import { setPrimaryFormState, type PickupFormState as FormState } from "@/modules/pickup/messages";

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
 * Создание/правка точки забора флориста (FloristPickupLocation). Точек может быть несколько;
 * ровно одна — основная (isPrimary), именно она уходит в Burq для новых заказов, если в самом
 * заказе точку не переключили вручную.
 *
 * Телефон нормализуется в E.164; адрес/штат/ZIP валидируются (US). Первая точка флориста
 * становится основной автоматически — иначе она была бы создана, но никуда не применялась.
 */
export async function ownerSavePickupLocation(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");

  const id = String(formData.get("id") ?? "").trim() || null;
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

  if (id) {
    const existing = await prisma.floristPickupLocation.findUnique({ where: { id }, select: { floristId: true, isPrimary: true } });
    if (!existing || existing.floristId !== floristId) return { error: "Точка не найдена." };
    // Отключить основную точку нельзя, пока есть другие: заказы флориста молча перестали бы
    // получать доставку. Сначала назначьте основной другую.
    if (existing.isPrimary && !input.isActive) {
      const others = await prisma.floristPickupLocation.count({ where: { floristId, id: { not: id }, isActive: true } });
      if (others > 0) return { error: "Это основная точка. Сначала сделайте основной другую, потом отключайте эту." };
    }
    await prisma.floristPickupLocation.update({ where: { id }, data: input });
  } else {
    const isFirst = (await prisma.floristPickupLocation.count({ where: { floristId } })) === 0;
    await prisma.floristPickupLocation.create({ data: { floristId, isPrimary: isFirst, ...input } });
  }

  // Настройка/активация точки разблокирует ждущие заказы этого флориста (WAITING_FOR_FLORIST).
  let rescheduled = 0;
  if (input.isActive) {
    rescheduled = await rescheduleQuietly(floristId);
  }

  revalidatePath("/dashboard/florists");
  return { ok: true, message: rescheduled ? `Точка забора сохранена. Перепланировано заказов: ${rescheduled}.` : "Точка забора сохранена." };
}

/** Назначить точку основной (владелец, любой флорист). */
export async function ownerSetPrimaryPickupLocation(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole("OWNER");
  const id = String(formData.get("id") ?? "");
  const floristId = String(formData.get("floristId") ?? "");
  if (!id || !floristId) return { error: "Не указана точка." };

  const res = await setPrimaryPickupLocation(prisma, { locationId: id, floristId });
  revalidatePath("/dashboard/florists");
  return setPrimaryFormState(res);
}

/** Перепланирование ждущих заказов не должно ронять сохранение точки. */
async function rescheduleQuietly(floristId: string): Promise<number> {
  try {
    return await rescheduleFloristWaitingOrders(prisma, floristId);
  } catch (err) {
    console.error(`[burq] reschedule florist waiting orders failed (${floristId}):`, err instanceof Error ? err.message : String(err));
    return 0;
  }
}
