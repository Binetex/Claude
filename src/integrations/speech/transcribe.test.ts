import { describe, it, expect, vi } from "vitest";
import { createTranscriber } from "./transcribe";

/** Распознавание голоса: любой сбой — «напишите текстом», а не падение обработчика. */
const cfg = { apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "whisper-1" };
const audio = { bytes: new Uint8Array([1, 2, 3]), filename: "voice.ogg", mime: "audio/ogg" };

describe("распознавание голосового", () => {
  it("отдаёт текст и шлёт файл multipart'ом с моделью", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: " напиши что привезём после пяти " }), { status: 200 }));
    const text = await createTranscriber(cfg, fetchImpl as unknown as typeof fetch)(audio);

    expect(text).toBe("напиши что привезём после пяти");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("model")).toBe("whisper-1");
  });

  it("ошибка сервиса — null, не исключение", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(createTranscriber(cfg, fetchImpl as unknown as typeof fetch)(audio)).resolves.toBeNull();
  });

  it("пустая расшифровка — тоже null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "  " }), { status: 200 }));
    await expect(createTranscriber(cfg, fetchImpl as unknown as typeof fetch)(audio)).resolves.toBeNull();
  });
});
