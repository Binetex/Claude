"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { saveBurqSettings, checkBurqConnection, setBurqDraftCreation, type BurqEnvironment } from "@/integrations/delivery/burq/settings";

type FormState = { ok?: boolean; error?: string; message?: string } | null;

/**
 * Сохранение настроек Burq. Доступно ЛЮБОМУ аутентифицированному пользователю (requireUser,
 * НЕ OWNER-only). formData НЕ логируется; секреты шифруются в сервисе и наружу не возвращаются.
 */
export async function saveBurqSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const environment = (String(formData.get("environment") ?? "SANDBOX") === "PRODUCTION" ? "PRODUCTION" : "SANDBOX") as BurqEnvironment;
  const enabled = String(formData.get("enabled") ?? "") === "1";
  // Пустые секреты = «не менять». Не тримим здесь во избежание утечки — сервис обрежет.
  const apiKey = formData.get("apiKey");
  const webhookSecret = formData.get("webhookSecret");
  const apiBaseUrl = String(formData.get("apiBaseUrl") ?? "").trim();

  const num = (k: string): number | undefined => {
    const v = Number(formData.get(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const dimensions = {
    length: num("dimLength"),
    width: num("dimWidth"),
    height: num("dimHeight"),
    weight: num("dimWeight"),
    dimensionUnit: String(formData.get("dimensionUnit") ?? "in"),
    weightUnit: String(formData.get("weightUnit") ?? "lb"),
  };

  const res = await saveBurqSettings(
    {
      environment,
      enabled,
      apiKey: typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined,
      webhookSecret: typeof webhookSecret === "string" && webhookSecret.length > 0 ? webhookSecret : undefined,
      apiBaseUrl: apiBaseUrl || undefined,
      dimensions,
    },
    user.id
  );
  if (!res.ok) return { error: res.error };
  revalidatePath("/dashboard/burq");
  return { ok: true, message: "Настройки сохранены. Секреты зашифрованы; в UI показывается только маска." };
}

/** Проверка подключения (безопасный read-only GET, заказы не создаются). */
export async function checkBurqConnectionAction(): Promise<FormState> {
  const user = await requireUser();
  const res = await checkBurqConnection(user.id);
  revalidatePath("/dashboard/burq");
  return res.ok ? { ok: true, message: res.message } : { error: res.message };
}

/** Переключатель гейта авто-создания draft (ВЫКЛ до подтверждения sandbox). */
export async function toggleBurqDraftCreationAction(enabled: boolean): Promise<FormState> {
  const user = await requireUser();
  const res = await setBurqDraftCreation(enabled, user.id);
  if (!res.ok) return { error: res.error };
  revalidatePath("/dashboard/burq");
  return { ok: true, message: enabled ? "Авто-создание draft включено." : "Авто-создание draft выключено." };
}
