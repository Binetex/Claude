import { readFile } from "fs/promises";
import path from "path";

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

  // Защита от path traversal: только безопасное базовое имя.
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()];
  if (!contentType) return new Response("Not found", { status: 404 });

  try {
    const file = await readFile(path.join(process.cwd(), "public", "uploads", name));
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
