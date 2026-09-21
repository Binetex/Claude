"use client";
/**
 * Загрузка своего фото. Тот же путь, что у фото букета: браузер жмёт картинку до разумного
 * размера, на сервер уходит data URL, файл ложится на диск и отдаётся через /api/media.
 *
 * Превью показывается сразу, до ответа сервера: иначе между выбором файла и перерисовкой
 * страницы кружок пустой, и кажется, что ничего не произошло. На ошибке превью возвращается
 * к сохранённому, чтобы на экране не осталось фото, которого на сервере нет.
 */
import { useRef, useState, useTransition } from "react";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/Card";
import { Avatar } from "@/components/Avatar";
import { compressImage } from "@/lib/imageCompress";
import { looksLikeImage } from "@/components/orders/BouquetPhotoButton";
import { saveAvatarAction, removeAvatarAction } from "./actions";

export function AvatarForm({ name, email, role, avatarUrl }: { name: string; email: string; role: string; avatarUrl: string | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(avatarUrl);
  const [pending, start] = useTransition();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // то же фото можно выбрать повторно
    if (!looksLikeImage(file)) return toast.error("Это не изображение — выберите фотографию.");
    let dataUrl: string;
    try {
      dataUrl = await compressImage(file);
    } catch (err) {
      return toast.error(err instanceof Error ? err.message : "Не удалось обработать фото");
    }
    const previous = preview;
    setPreview(dataUrl);
    start(async () => {
      const res = await saveAvatarAction(dataUrl);
      if (res.ok) toast.success("Фото сохранено");
      else {
        setPreview(previous);
        toast.error(res.error ?? "Не удалось сохранить фото");
      }
    });
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center gap-4">
        <Avatar name={name} src={preview} size={72} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800">{name}</p>
          <p className="truncate text-xs text-slate-500">{email}</p>
          <p className="mt-0.5 text-xs text-slate-400">{role}</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => fileRef.current?.click()}>
            <Camera aria-hidden className="mr-1.5 size-4" />
            {pending ? "Сохраняю…" : preview ? "Заменить фото" : "Загрузить фото"}
          </Button>
          {preview && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await removeAvatarAction();
                  if (res.ok) { setPreview(null); toast.success("Фото убрано"); }
                  else toast.error(res.error ?? "Не удалось убрать фото");
                })
              }
            >
              Убрать
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
