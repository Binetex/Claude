/**
 * Диагностика подключения домена к Email Factory.
 *
 * ЗАЧЕМ. Панель Email Factory показывает шаг «Ждём подтверждения» и крутится, не называя причину.
 * Гадать, какая из четырёх записей не сошлась, по одному спиннеру нельзя, а сверять DKIM-ключ на
 * 216 символов глазами — это способ не заметить расхождение, а не найти его.
 *
 * ЧТО ДЕЛАЕТ. Спрашивает у API состояние домена, вынимает записи, которые он требует, и резолвит
 * каждую из них в живом DNS. Печатает построчно: что ожидается, что отвечает DNS, сошлось или нет.
 * Только чтение — ни домен не подключает, ни записи не создаёт, ни письма не шлёт.
 *
 * ЗАПУСК:
 *   EMAIL_FACTORY_TOKEN=... npx tsx scripts/email-factory-domain-doctor.ts juliesflowers.net
 * либо, если токен уже сохранён в базе через «Сайты» (тогда нужен DATABASE_URL и ключ шифрования):
 *   npm run email-factory:doctor -- juliesflowers.net
 *
 * `--raw` дополнительно печатает ответ API целиком — на случай, если провайдер поменяет формат и
 * разбор ниже перестанет узнавать записи.
 */
import dns from "node:dns/promises";

const BASE_URL = "https://mail.binetex.com";

type Expected = { name: string; type: string; value: string; priority?: number };

/** Токен: сначала env (ничего не поднимаем), и только потом база. */
async function resolveToken(): Promise<string> {
  const fromEnv = (process.env.EMAIL_FACTORY_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;

  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { resolveEmailFactoryToken } = await import("../src/integrations/emailFactory/token");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const token = await resolveEmailFactoryToken(prisma);
    if (!token) {
      throw new Error(
        "Токена нет: ни в EMAIL_FACTORY_TOKEN, ни в базе. Задайте переменную окружения или сохраните токен на «Сайтах»."
      );
    }
    return token;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Формат записей у провайдера не документирован, поэтому ищем их по смыслу, а не по одному
 * известному пути: обходим ответ целиком и берём каждый объект, похожий на DNS-запись. Жёсткий
 * путь молча отдал бы пустой список при первом же переименовании поля.
 */
function collectExpected(payload: unknown): Expected[] {
  const out: Expected[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;

    const o = node as Record<string, unknown>;
    const str = (...keys: string[]): string | null => {
      for (const k of keys) if (typeof o[k] === "string" && o[k]) return (o[k] as string).trim();
      return null;
    };

    const type = str("type", "recordType")?.toUpperCase() ?? null;
    const value = str("value", "data", "content", "target", "pointsTo", "points_to");
    if (type && value && ["TXT", "MX", "CNAME", "A"].includes(type)) {
      const name = str("name", "host", "record", "hostname") ?? "@";
      const rawPriority = o.priority ?? o.prio ?? o.preference;
      const priority = typeof rawPriority === "number" ? rawPriority : undefined;
      const key = `${type}|${name}|${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, type, value, priority });
      }
    }

    for (const v of Object.values(o)) walk(v);
  };

  walk(payload);
  return out;
}

/** Полное имя записи: провайдеры пишут его то относительно зоны, то целиком. */
function fqdn(name: string, domain: string): string {
  const n = name.replace(/\.$/, "");
  if (!n || n === "@" || n === domain) return domain;
  return n.endsWith(`.${domain}`) ? n : `${n}.${domain}`;
}

/** Сравнение без того, что в DNS не значимо: регистр, точка на конце, лишние пробелы. */
function norm(v: string): string {
  return v.trim().replace(/\.$/, "").replace(/\s+/g, " ").toLowerCase();
}

async function lookupActual(rec: Expected, domain: string): Promise<string[]> {
  const host = fqdn(rec.name, domain);
  try {
    if (rec.type === "TXT") {
      // Длинный TXT приезжает нарезанным на куски по 255 байт — склеиваем, иначе DKIM-ключ
      // никогда не совпадёт с ожидаемым.
      return (await dns.resolveTxt(host)).map((chunks) => chunks.join(""));
    }
    if (rec.type === "MX") {
      return (await dns.resolveMx(host)).map((m) => `${m.priority} ${m.exchange}`);
    }
    if (rec.type === "CNAME") return await dns.resolveCname(host);
    return await dns.resolve4(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw err;
  }
}

/**
 * Сошлась ли запись. У MX ожидаемое значение приходит то с приоритетом внутри строки, то
 * отдельным полем, то без него вовсе, поэтому хост сверяем всегда, а приоритет — только когда
 * провайдер его назвал.
 */
function matches(rec: Expected, actual: string[]): boolean {
  const want = norm(rec.value);
  if (rec.type !== "MX") return actual.some((a) => norm(a) === want);

  const wantHost = norm(want.replace(/^\d+\s+/, ""));
  const wantPriority = rec.priority ?? (/^(\d+)\s+/.exec(want)?.[1] ? Number(/^(\d+)\s+/.exec(want)![1]) : null);
  return actual.some((a) => {
    const [prio, ...rest] = norm(a).split(" ");
    if (norm(rest.join(" ")) !== wantHost) return false;
    return wantPriority === null || Number(prio) === wantPriority;
  });
}

function shorten(v: string): string {
  return v.length > 96 ? `${v.slice(0, 60)}…${v.slice(-24)} (${v.length} симв.)` : v;
}

async function main() {
  const args = process.argv.slice(2);
  const raw = args.includes("--raw");
  const domain = args.find((a) => !a.startsWith("--"));
  if (!domain) {
    console.error("Укажите домен: npx tsx scripts/email-factory-domain-doctor.ts juliesflowers.net");
    process.exit(1);
  }

  const token = await resolveToken();
  const res = await fetch(`${BASE_URL}/api/v1/domains/${encodeURIComponent(domain)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();

  if (!res.ok) {
    console.error(`\nAPI ответил ${res.status}:\n${body}\n`);
    process.exit(1);
  }

  const payload = JSON.parse(body) as Record<string, unknown>;
  const d = (payload.data ?? payload) as Record<string, unknown>;

  console.log(`\n══ ${domain} ══`);
  console.log(`Статус:  ${String(d.status ?? "?")}`);
  if (d.email) console.log(`Адрес:   ${String(d.email)}`);
  if (d.id) console.log(`ID:      ${String(d.id)}`);

  // Шаги провижининга: сам провайдер уже знает, на каком именно застряло.
  const steps = (d.steps ?? d.provisioning ?? d.progress) as unknown;
  if (Array.isArray(steps)) {
    console.log("\nШаги провижининга:");
    for (const s of steps as Record<string, unknown>[]) {
      const name = String(s.name ?? s.step ?? s.title ?? "?");
      const state = String(s.status ?? s.state ?? "?");
      const detail = s.message ?? s.detail ?? s.error;
      console.log(`  ${state.toUpperCase().padEnd(12)} ${name}${detail ? ` — ${String(detail)}` : ""}`);
    }
  }

  const expected = collectExpected(payload);
  if (expected.length === 0) {
    console.log("\nAPI не вернул ни одной DNS-записи в узнаваемом виде. Запустите с --raw и посмотрите ответ целиком.");
  } else {
    console.log(`\nЗаписи, которых ждёт Email Factory (${expected.length}):\n`);
    let bad = 0;
    for (const rec of expected) {
      const actual = await lookupActual(rec, domain);
      const ok = matches(rec, actual);
      if (!ok) bad += 1;
      console.log(`${ok ? "✓" : "✗"} ${rec.type.padEnd(5)} ${fqdn(rec.name, domain)}`);
      console.log(`    ожидается: ${shorten(rec.priority !== undefined && rec.type === "MX" ? `${rec.priority} ${rec.value}` : rec.value)}`);
      console.log(`    в DNS:     ${actual.length ? actual.map(shorten).join("\n               ") : "— записи нет —"}`);
      console.log("");
    }

    console.log(
      bad === 0
        ? "ИТОГ: все записи на месте и совпадают. Значит дело не в DNS — жмите «Повторить», и если снова висит, причина на стороне Email Factory / Resend."
        : `ИТОГ: не сошлось записей — ${bad}. Пока они не совпадут дословно, подтверждение не пройдёт.`
    );
  }

  if (raw) console.log(`\n── ответ API целиком ──\n${JSON.stringify(payload, null, 2)}`);
  console.log("");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
