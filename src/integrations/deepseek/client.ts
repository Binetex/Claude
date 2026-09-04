import "server-only";
/**
 * HTTP-клиент DeepSeek (OpenAI-совместимый `/chat/completions`).
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
const RETRY_DELAY_MS = 1_500;

export function createDeepseekClient(config: DeepseekConfig, deps: DeepseekClientDeps = {}) {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  async function once(messages: DeepseekMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages,
          // Ответ читает не человек, а код: нужен предсказуемый JSON, а не свободный текст.
          response_format: { type: "json_object" },
          // Низкая температура: это служебная переписка, а не сочинение.
          temperature: 0.2,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw deepseekErrorFromStatus(res.status, await res.text().catch(() => ""));
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new DeepseekError("empty", "DeepSeek вернул пустой ответ", true);
      return text;
    } catch (err) {
      if (err instanceof DeepseekError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new DeepseekError("timeout", `DeepSeek не ответил за ${TIMEOUT_MS / 1000} с`, true);
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
