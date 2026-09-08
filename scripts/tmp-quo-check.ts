/** РАЗОВАЯ проверка (07.09.2026): жив ли аккаунт QUO. Только чтение, ничего не отправляет. */
import { getQuoConfig } from "../src/integrations/quo/config";
import { createQuoClient } from "../src/integrations/quo/client";

async function main() {
  const cfg = getQuoConfig();
  if (!cfg) {
    console.log("QUO не настроен на сервере (нет ключа или выключен).");
    return;
  }
  const client = createQuoClient({ ...cfg, maxRetries: 0 });
  try {
    const nums = await client.listPhoneNumbers();
    console.log(`OK: аккаунт отвечает, номеров в аккаунте: ${nums.length}`);
    for (const n of nums) console.log(`  ${n.number ?? "(без номера)"} · ${n.id}`);
  } catch (err) {
    const e = err as { kind?: string; status?: number; safeCode?: string | null; message?: string };
    console.log(`ОТКАЗ: kind=${e.kind} status=${e.status} code=${e.safeCode ?? "-"} — ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
