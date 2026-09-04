import "server-only";
/**
 * Перевод заготовки владельца на английский при сохранении. Переменные `{{...}}` обязаны
 * пережить перевод нетронутыми: набор до и после сверяется, иначе перевод отвергается.
 */
import type { DeepseekClient } from "@/integrations/deepseek/client";
import { extractVariables } from "@/modules/messaging/template";
import { looksEnglish } from "./prompt";

export async function translateTemplate(client: DeepseekClient, text: string): Promise<string | null> {
  try {
    const res = await client.complete([
      {
        role: "system",
        content:
          'You translate a flower shop\'s SMS template into natural, friendly English. Keep every placeholder like {{tracking_url}} EXACTLY as written, in the same places. Keep line breaks. No greetings, no signature, no quotes. Answer with JSON only: {"text": "..."}',
      },
      { role: "user", content: text },
    ]);
    const parsed = JSON.parse(res.text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as { text?: unknown };
    const out = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!out || !looksEnglish(out)) return null;
    const before = [...extractVariables(text)].sort().join(",");
    const after = [...extractVariables(out)].sort().join(",");
    if (before !== after) return null;
    return out;
  } catch {
    return null;
  }
}
