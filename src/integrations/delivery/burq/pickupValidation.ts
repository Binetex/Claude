/**
 * Валидация pickup-локации флориста перед созданием Burq draft. Чистые функции.
 * Pickup ОБЯЗАТЕЛЕН и берётся ТОЛЬКО из FloristPickupLocation назначенного флориста.
 * Никаких fallback на Site/Google/customer/env/другого флориста.
 */

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

/** E.164: "+" и 8–15 цифр, первая не 0. */
export function isE164(phone: string | null | undefined): boolean {
  return /^\+[1-9]\d{7,14}$/.test((phone ?? "").trim());
}

/** 2-буквенный код штата США (регистронезависимо). */
export function isUsState(state: string | null | undefined): boolean {
  return US_STATES.has((state ?? "").trim().toUpperCase());
}

/** US ZIP: 5 цифр или ZIP+4. */
export function isUsZip(zip: string | null | undefined): boolean {
  return /^\d{5}(-\d{4})?$/.test((zip ?? "").trim());
}

export type PickupLocationInput = {
  locationName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  isActive?: boolean | null;
};

export type PickupValidationResult = { valid: boolean; errors: string[] };

/**
 * Проверяет, что pickup-локация полна и валидна для Burq draft.
 * Возвращает список машинных кодов ошибок (без PII) для флага «настройте pickup».
 */
export function validatePickupLocation(loc: PickupLocationInput | null | undefined): PickupValidationResult {
  const errors: string[] = [];
  if (!loc) return { valid: false, errors: ["pickup_missing"] };
  if (loc.isActive === false) errors.push("pickup_inactive");
  if (!loc.locationName?.trim()) errors.push("location_name_required");
  if (!loc.contactName?.trim()) errors.push("contact_name_required");
  if (!isE164(loc.contactPhone)) errors.push("contact_phone_invalid");
  if (!loc.addressLine?.trim()) errors.push("address_line_required");
  if (!loc.city?.trim()) errors.push("city_required");
  if (!isUsState(loc.state)) errors.push("state_invalid");
  if (!isUsZip(loc.zip)) errors.push("zip_invalid");
  return { valid: errors.length === 0, errors };
}
