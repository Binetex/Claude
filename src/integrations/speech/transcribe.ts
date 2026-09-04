import "server-only";
/**
 * Распознавание голосовых сообщений владельца в Telegram.
 *
 * DeepSeek звук не понимает, поэтому нужен отдельный сервис. Берём OpenAI-совместимый формат
 * (`/audio/transcriptions`, multipart): он же у Groq и у ряда других, так что провайдер меняется
 * двумя переменными окружения, а не кодом.
 *
 * Не настроен — это не ошибка, а «голос пока не подключён»: владельцу так и говорим в чат.
 */
export type SpeechConfig = { apiKey: string; baseUrl: string; model: string };

export function getSpeechConfig(): SpeechConfig | null {
  const apiKey = process.env.SPEECH_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.SPEECH_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.SPEECH_MODEL?.trim() || "whisper-1",
  };
}

const TIMEOUT_MS = 30_000;

export type Transcriber = (audio: { bytes: Uint8Array; filename: string; mime: string }) => Promise<string | null>;

/** Возвращает текст или null: сбой распознавания — повод попросить написать текстом, не падать. */
export function createTranscriber(cfg: SpeechConfig, fetchImpl: typeof fetch = fetch): Transcriber {
  return async ({ bytes, filename, mime }) => {
    const form = new FormData();
    // Копия в свежий ArrayBuffer: Blob не принимает представление поверх SharedArrayBuffer.
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append("model", cfg.model);
    // Владелец говорит по-русски или по-английски; подсказка языка снижает число ошибок,
    // но не запрещает второй язык — Whisper сам определит.
    form.append("response_format", "json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { text?: unknown } | null;
      const text = typeof json?.text === "string" ? json.text.trim() : "";
      return text || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
