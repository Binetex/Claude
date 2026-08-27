/**
 * Подготовка фото с телефона перед отправкой server action'ом.
 *
 * Делает две вещи, и обе обязательны.
 *
 * 1. НАРУЖУ ВСЕГДА УХОДИТ JPEG, каким бы ни был исходник. Картинка рисуется в canvas и
 *    перекодируется, поэтому в хранилище не попадает ни HEIC, ни что-либо ещё экзотическое —
 *    и фотография потом открывается везде: в карточке, в письме, в сообщении клиенту.
 *
 * 2. Размер режется до разумного. Без этого data URL исходного снимка (3–8 МБ) упирается в
 *    лимит тела запроса Next.js — именно это когда-то и ломало отправку фото букета.
 *
 * HEIC с айфона обрабатывается сам: сначала пробуем нарисовать средствами браузера (Safari это
 * умеет и делает быстрее всего), а если он не умеет — подключаем конвертер. Конвертер грузится
 * ТОЛЬКО в этот момент, отдельным куском: он весит больше мегабайта, и платить за него на
 * каждой загрузке страницы ради редкого случая незачем.
 *
 * Только браузер: использует FileReader, Image и canvas.
 */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

function isHeic(file: Blob & { name?: string }): boolean {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? "");
}

/** Рисует уже прочитанный data URL в canvas и отдаёт JPEG. */
function toJpeg(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("draw_failed"));
    img.onload = () => {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas недоступен"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    };
    img.src = dataUrl;
  });
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/** Конвертер HEIC. Импорт динамический: код грузится только когда попался такой файл. */
async function heicToJpegBlob(file: Blob): Promise<Blob> {
  const { default: heic2any } = await import("heic2any");
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: JPEG_QUALITY });
  // Живое фото (Live Photo) конвертер отдаёт массивом кадров — берём первый.
  return Array.isArray(out) ? out[0] : out;
}

export async function compressImage(file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);

  try {
    return await toJpeg(dataUrl);
  } catch (err) {
    const drawFailed = err instanceof Error && err.message === "draw_failed";
    if (!drawFailed) throw err;

    // Браузер не умеет рисовать этот формат. Для HEIC это ожидаемо везде, кроме Safari, и
    // именно здесь подключается конвертер — фотография с айфона не должна отвергаться из-за
    // того, что флорист открыл её на Android.
    if (!isHeic(file)) {
      throw new Error("Этот формат фото не поддерживается — попробуйте JPEG или PNG");
    }

    let converted: Blob;
    try {
      converted = await heicToJpegBlob(file);
    } catch {
      throw new Error("Не удалось преобразовать фото HEIC. Снимите фото прямо здесь или сохраните его как JPEG.");
    }
    return toJpeg(await readAsDataUrl(converted));
  }
}
