import "server-only";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";

/**
 * Абстракция хранилища изображений.
 *
 * Этап 1: локальный диск (public/uploads) — в БД сохраняем только ССЫЛКУ, не сам файл.
 * Позже реализация заменяется на S3-совместимый адаптер за тем же интерфейсом saveImage().
 */
export interface ImageStorage {
  saveImage(dataUrl: string): Promise<string>;
}

class LocalImageStorage implements ImageStorage {
  async saveImage(dataUrl: string): Promise<string> {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("Ожидался data URL изображения");
    const [, mime, b64] = match;
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    const buffer = Buffer.from(b64, "base64");
    const name = `${crypto.randomUUID()}.${ext}`;
    const dir = path.join(process.cwd(), "public", "uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), buffer);
    return `/uploads/${name}`;
  }
}

export const imageStorage: ImageStorage = new LocalImageStorage();
