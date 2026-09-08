import "server-only";
/**
 * Остаток средств на аккаунте модели.
 *
 * Смысл ровно один: когда деньги кончаются, ассистент замолкает — так же, как замолкали SMS при
 * нулевом балансе QUO. Лучше увидеть остаток заранее в настройках, чем по тишине в переписке.
 *
 * Баланс отдаёт только DeepSeek (GET /user/balance). У OpenAI для обычных project-ключей такого
 * метода нет — врать про «неизвестно» честнее, чем показывать выдуманное число.
 */
import type { DeepseekConfig } from "./config";

export type ModelBalance =
  | { supported: true; available: boolean; currency: string; total: string }
  | { supported: false; reason: string };

const TIMEOUT_MS = 8_000;

export async function fetchModelBalance(cfg: DeepseekConfig, fetchImpl: typeof fetch = fetch): Promise<ModelBalance> {
  if (!/(^|\.)api\.deepseek\.com$/i.test(safeHost(cfg.baseUrl))) {
    return { supported: false, reason: "Этот провайдер не отдаёт остаток по API — смотрите в своём кабинете." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/user/balance`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return { supported: false, reason: `Не удалось узнать остаток (${res.status}).` };
    const json = (await res.json()) as { is_available?: boolean; balance_infos?: { currency?: string; total_balance?: string }[] };
    const first = json.balance_infos?.[0];
    if (!first?.total_balance) return { supported: false, reason: "Провайдер не вернул остаток." };
    return { supported: true, available: json.is_available !== false, currency: first.currency ?? "USD", total: first.total_balance };
  } catch {
    return { supported: false, reason: "Не удалось узнать остаток: сервис не ответил." };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
