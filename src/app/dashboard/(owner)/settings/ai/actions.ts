"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { isCredentialCryptoConfigured } from "@/lib/crypto/secretBox";
import { createDeepseekClient } from "@/integrations/deepseek/client";
import { saveAiModelSettings, clearAiModelKey, resolveDeepseekConfig, recordAiModelCheck } from "@/integrations/deepseek/settings";

type Result = { ok?: true; message?: string; error?: string };

const PATH = "/dashboard/settings/ai";

/**
 * Сохранение доступа к модели. Владелец и только он: ключ оплачивается его счётом, а модель
 * определяет, что уйдёт клиенту.
 *
 * Пустое поле ключа = «не менять» — тот же приём, что у Burq и Airwallex: маска на экране
 * показывает последние символы, а расшифрованный ключ наружу не возвращается никогда.
 */
export async function ownerSaveAiModel(_prev: Result | null, formData: FormData): Promise<Result> {
  const user = await requireRole("OWNER");
  const apiKey = String(formData.get("apiKey") ?? "");
  const baseUrl = String(formData.get("baseUrl") ?? "");
  const model = String(formData.get("model") ?? "");

  if (apiKey.trim() && !isCredentialCryptoConfigured()) {
    return { error: "На сервере не настроено шифрование секретов (CREDENTIALS_ENCRYPTION_KEY) — ключ сохранять некуда." };
  }

  const res = await saveAiModelSettings(prisma, { apiKey, baseUrl, model, userId: user.id });
  if (!res.ok) return { error: res.error };

  revalidatePath(PATH);
  return { ok: true, message: "Сохранено. Нажмите «Проверить» — я задам модели короткий вопрос и покажу ответ." };
}

/** Убрать ключ из базы: ассистент вернётся к переменной окружения или замолчит. */
export async function ownerClearAiKey(): Promise<Result> {
  const user = await requireRole("OWNER");
  await clearAiModelKey(prisma, user.id);
  revalidatePath(PATH);
  return { ok: true, message: "Ключ убран из базы." };
}

/**
 * Живая проверка: настоящий вызов модели тем же клиентом, что работает в ассистенте.
 *
 * Просим ответить одним словом в JSON — так проверяются сразу три вещи: ключ принят, модель
 * существует и она умеет отвечать в нужном формате (у ассистента ответ разбирается кодом).
 */
export async function ownerCheckAiModel(): Promise<Result> {
  await requireRole("OWNER");
  const cfg = await resolveDeepseekConfig(prisma);
  if (!cfg) return { error: "Ключ не задан ни в настройках, ни в окружении — проверять нечего." };

  const client = createDeepseekClient(cfg);
  try {
    const res = await client.complete([
      { role: "system", content: 'Reply with JSON only: {"ok":"yes"}' },
      { role: "user", content: "ping" },
    ]);
    await recordAiModelCheck(prisma, { ok: true });
    revalidatePath(PATH);
    return { ok: true, message: `Модель ${cfg.model} ответила за ${res.latencyMs} мс.` };
  } catch (err) {
    // Наружу отдаём только безопасный текст: в сообщении провайдера может быть эхо запроса.
    const safe = err instanceof Error ? err.message.slice(0, 200) : "неизвестная ошибка";
    await recordAiModelCheck(prisma, { ok: false, errorSafe: safe });
    revalidatePath(PATH);
    return { error: `Модель не ответила: ${safe}` };
  }
}
