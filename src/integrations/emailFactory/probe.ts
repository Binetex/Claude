import "server-only";
/**
 * Разведка API Email Factory — ВРЕМЕННЫЙ диагностический инструмент, пока интеграции ещё нет.
 * Отвечает на вопросы, от которых зависит объём работ: понимает ли API фильтр по адресу
 * получателя (а не только по домену), есть ли подписки на вебхуки, как выглядит письмо в ответе.
 *
 * Два правила, ради которых это отдельный файл, а не пара строк в action:
 *
 * 1. ТОЛЬКО GET, список запросов зашит здесь. Ни одного POST: `POST /api/v1/messages` отправляет
 *    настоящее письмо живому человеку, и «диагностика», умеющая писать, рано или поздно напишет.
 *
 * 2. НАРУЖУ ОТДАЮТСЯ ТОЛЬКО ИМЕНА ПОЛЕЙ, никогда значения. В ответе лежит переписка с клиентами:
 *    адреса, темы, тексты. Чтобы понять формат, достаточно знать, КАК называются поля — этого и
 *    хватает, а содержимое чужих писем не должно попасть ни на экран, ни в логи, ни в отчёт.
 */
import { EMAIL_FACTORY_BASE_URL } from "./token";

const TIMEOUT_MS = 10_000;

export type ProbeResult = {
  label: string;
  path: string;
  status: number | null;
  /** Имена полей верхнего уровня ответа — без значений. */
  topLevelKeys: string[];
  /** Имена полей первого элемента списка, если ответ — список писем. Без значений. */
  itemKeys: string[];
  /** Сколько элементов пришло. Само по себе не секрет и помогает понять, пустой ответ или нет. */
  itemCount: number | null;
  errorSafe: string | null;
};

/** Имена полей объекта, без значений. */
function keysOf(v: unknown): string[] {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).slice(0, 40) : [];
}

/** Первый массив в ответе — под каким бы именем он ни лежал (data / items / messages / …). */
function findList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

async function probe(token: string, label: string, path: string): Promise<ProbeResult> {
  const base: ProbeResult = { label, path, status: null, topLevelKeys: [], itemKeys: [], itemCount: null, errorSafe: null };
  try {
    const res = await fetch(`${EMAIL_FACTORY_BASE_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Не JSON — скорее всего HTML страницы входа. Тело не показываем: в нём может быть что угодно.
      return { ...base, status: res.status, errorSafe: `ответ не JSON (${text.length} байт)` };
    }

    const list = findList(body);
    return {
      ...base,
      status: res.status,
      topLevelKeys: keysOf(body),
      itemKeys: list && list.length ? keysOf(list[0]) : [],
      itemCount: list ? list.length : null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, errorSafe: msg.slice(0, 200) };
  }
}

/**
 * Прогон разведки. `sampleAddress` — адрес, на котором проверяется фильтр по получателю; пустой
 * пропускает эту проверку. Сам адрес в отчёт не попадает, только результат запроса.
 */
export async function runEmailFactoryProbe(token: string, sampleAddress: string): Promise<ProbeResult[]> {
  const addr = sampleAddress.trim();
  const checks: { label: string; path: string }[] = [
    { label: "Доступ и формат письма", path: "/api/v1/messages?limit=1" },
    { label: "Фильтр по направлению", path: "/api/v1/messages?direction=inbound&limit=1" },
    { label: "Подписки на вебхуки", path: "/api/v1/webhooks" },
  ];
  if (addr) {
    checks.splice(1, 0, { label: "Фильтр по адресу получателя", path: `/api/v1/messages?to=${encodeURIComponent(addr)}&limit=1` });
  }

  // Последовательно, а не параллельно: у чужого сервиса может стоять ограничение частоты, и
  // словить 429 на разведке — значит не узнать ничего.
  const out: ProbeResult[] = [];
  for (const c of checks) out.push(await probe(token, c.label, c.path));
  return out;
}
