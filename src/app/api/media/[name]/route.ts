import { readFile } from "fs/promises";
import path from "path";
import { uploadedFilePath } from "@/lib/storage";

// Раздаёт загруженные файлы из public/uploads. Нужно потому, что `next start` отдаёт из public/
// ТОЛЬКО файлы, существовавшие на момент сборки; файлы, загруженные в рантайме (аватарки,
// фото букета), статикой не отдаются (404). Здесь читаем файл с диска и стримим сами.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  // Защита от path traversal: только безопасное базовое имя (`uploadedFilePath` — одно правило на всех).
  const file = uploadedFilePath(name);
  if (!file) return new Response("Not found", { status: 404 });
  const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()];
  if (!contentType) return new Response("Not found", { status: 404 });

  try {
    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
