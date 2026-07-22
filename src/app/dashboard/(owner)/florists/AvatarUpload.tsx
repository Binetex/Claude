"use client";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { FloristAvatar } from "@/components/FloristAvatar";

// Храним чуть крупнее показа (26px), чтобы на retina было чётко; файл всё равно крошечный (~3-6КБ).
const OUT_SIZE = 96;
const JPEG_QUALITY = 0.85;

/** Обрезает по центру в квадрат и сжимает в маленький JPEG data URL (см. compressImage для фото букета). */
function compressSquare(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Не удалось загрузить изображение"));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = OUT_SIZE;
        canvas.height = OUT_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas недоступен"));
          return;
        }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT_SIZE, OUT_SIZE);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** Поле загрузки аватарки: превью + <input type=file>, значение кладём в скрытый avatarDataUrl. */
export function AvatarUpload({
  name,
  currentUrl,
  label = "Аватарка",
}: {
  name: string;
  currentUrl?: string | null;
  label?: string;
}) {
  const [preview, setPreview] = useState<string | null>(currentUrl ?? null);
  const [dataUrl, setDataUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const url = await compressSquare(file);
      setDataUrl(url);
      setPreview(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось обработать изображение");
    }
  }

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <FloristAvatar name={null} avatarUrl={preview} size={40} />
        <input type="file" accept="image/*" onChange={onPick} className="text-xs text-slate-600" />
      </div>
      <input type="hidden" name={name} value={dataUrl} />
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
