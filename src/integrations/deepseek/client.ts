import "server-only";
/**
 * HTTP-клиент модели ассистента. Протокол — OpenAI-совместимый `/chat/completions`, поэтому за
 * ним одинаково работают и DeepSeek, и OpenAI: адрес и модель приходят из настроек.
 *
 * Отвечает клиенту живой человек по ту сторону SMS, поэтому ждать бесконечно нельзя: жёсткий
 * таймаут и ровно один повтор на временную ошибку. Не ответила — ассистент молчит, а сигнал
 * уходит владельцу; это лучше, чем сообщение через десять минут.
 *
 * Ответ просим строго в JSON (`response_format`), потому что дальше по нему принимаются решения:
 * отправлять самому или нести человеку. Свободный текст пришлось бы разбирать регулярками.
 */
import { deepseekErrorFromStatus, DeepseekError } from "./errors";
import type { DeepseekConfig } from "./config";

export type DeepseekMessage = { role: "system" | "user" | "assistant"; content: string };

export type DeepseekCallResult = {
  /** Сырой текст ответа модели — кладём в журнал как есть. */
  text: string;
  model: string;
  latencyMs: number;
};

export type DeepseekClientDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const TIMEOUT_MS = 20_000;
/**
 * Рассуждающим моделям (gpt-5*, o1/o3/o4, deepseek-reasoner) двадцати секунд мало: в замерах на
 * реальном промпте они отвечали 12–30 с. Ждём дольше — ответ всё равно уходит человеку черновиком.
 */
const REASONING_TIMEOUT_MS = 60_000;
/**
 * Потолок токенов для рассуждающих моделей. Замер на боевом ключе: deepseek-reasoner тратит
 * 750–3200 токенов даже на «ping», а на настоящем промпте (11 КБ) при лимите 4000 один ответ из
 * трёх возвращался ПУСТЫМ — модель израсходовала лимит на размышление и до ответа не дошла.
 * Пустой ответ хуже лишних токенов: клиент остаётся без ответа, а владелец без черновика.
 */
const REASONING_MAX_TOKENS = 8000;
const RETRY_DELAY_MS = 1_500;

/**
 * Модель «рассуждающая»: тратит токены на размышление перед ответом.
 *
 * Это не косметика. У таких моделей OpenAI ДРУГИЕ имена параметров: `max_completion_tokens`
 * вместо `max_tokens`, и `temperature` они не принимают вовсе — запрос со старыми полями
 * отклоняется с 400. А общий лимит должен покрывать и размышление, и сам ответ: с 700 токенами
 * ответ возвращается пустым.
 */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("chat-latest")) return false; // gpt-5-chat-latest — обычная чат-модель
  return /^(gpt-5|o[1-9])/.test(m) || m.includes("reasoner");
}

export function createDeepseekClient(config: DeepseekConfig, deps: DeepseekClientDeps = {}) {
  const reasoning = isReasoningModel(config.model);
  const timeoutMs = reasoning ? REASONING_TIMEOUT_MS : TIMEOUT_MS;
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  async function once(messages: DeepseekMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages,
          // Ответ читает не человек, а код: нужен предсказуемый JSON, а не свободный текст.
          response_format: { type: "json_object" },
          // Рассуждающие модели не принимают temperature и считают лимит вместе с размышлением.
          ...(reasoning
            ? { max_completion_tokens: REASONING_MAX_TOKENS }
            : { temperature: 0.2, max_tokens: 700 }),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw deepseekErrorFromStatus(res.status, await res.text().catch(() => ""));
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new DeepseekError("empty", "Модель вернула пустой ответ", true);
      return text;
    } catch (err) {
      if (err instanceof DeepseekError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new DeepseekError("timeout", `Модель не ответила за ${timeoutMs / 1000} с`, true);
      }
      throw new DeepseekError("network", err instanceof Error ? err.message : String(err), true);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Один вопрос модели. Ровно один повтор на временную ошибку — человек ждёт ответа. */
    async complete(messages: DeepseekMessage[]): Promise<DeepseekCallResult> {
      const started = now();
      try {
        const text = await once(messages);
        return { text, model: config.model, latencyMs: now() - started };
      } catch (err) {
        if (err instanceof DeepseekError && err.retryable) {
          await sleep(RETRY_DELAY_MS);
          const text = await once(messages);
          return { text, model: config.model, latencyMs: now() - started };
        }
        throw err;
      }
    },
  };
}

export type DeepseekClient = ReturnType<typeof createDeepseekClient>;
