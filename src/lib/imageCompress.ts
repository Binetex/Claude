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

/* ─────────────────────────  EXIF  ─────────────────────────
 * Перекодирование через canvas срезает метаданные целиком: наружу уходит голый JPEG без
 * даты съёмки, камеры и геометки. Владельцу они нужны — фотографии уходят дальше, в том
 * числе в другие сервисы, и там от снимка ждут обычных свойств файла.
 *
 * Поэтому исходный блок EXIF вынимается из оригинала ДО перекодирования и вставляется в
 * готовый JPEG. Работа чисто байтовая, без библиотек: разбирать нужно три вещи — границы
 * сегмента APP1, порядок байт TIFF и один тег внутри него.
 *
 * ВАЖНО про ориентацию. canvas рисует снимок уже развёрнутым (браузер применяет EXIF
 * Orientation сам), поэтому скопировать тег как есть нельзя: смотрелка развернула бы
 * картинку второй раз. Тег принудительно ставится в 1 — «верх сверху».
 *
 * HEIC остаётся без метаданных: конвертер отдаёт новый JPEG, исходного EXIF в нём уже нет.
 * Это ограничение формата, а не недоделка — на айфоне лечится режимом «Наиболее совместимые».
 */

const SOI = 0xd8;
const SOS = 0xda;
const APP1 = 0xe1;
const ORIENTATION_TAG = 0x0112;

/** Сегмент APP1 с EXIF целиком (вместе с маркером и длиной) или null, если его нет. */
export function extractExifApp1(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;

  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null; // поток испорчен — молча выходим, фото важнее метаданных
    const marker = bytes[i + 1];
    // Маркеры без полезной нагрузки: у них нет поля длины.
    if (marker === SOI || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (marker === SOS) return null; // дальше пиксели, сегментов больше не будет
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    if (marker === APP1 && isExifHeader(bytes, i + 4)) return bytes.slice(i, i + 2 + len);
    i += 2 + len;
  }
  return null;
}

function isExifHeader(b: Uint8Array, at: number): boolean {
  // "Exif\0\0" — иначе это APP1 с чем-то другим, например с XMP.
  return b[at] === 0x45 && b[at + 1] === 0x78 && b[at + 2] === 0x69 && b[at + 3] === 0x66 && b[at + 4] === 0 && b[at + 5] === 0;
}

/**
 * Ставит Orientation = 1 прямо в блоке APP1. Меняет переданный массив.
 * Тега может не быть — тогда ничего не делаем, это нормально.
 */
export function setOrientationUpright(app1: Uint8Array): void {
  const tiff = 10; // FF E1 + длина(2) + "Exif\0\0"(6)
  if (app1.length < tiff + 8) return;
  const little = app1[tiff] === 0x49 && app1[tiff + 1] === 0x49;
  const big = app1[tiff] === 0x4d && app1[tiff + 1] === 0x4d;
  if (!little && !big) return;

  const u16 = (at: number) => (little ? app1[at] | (app1[at + 1] << 8) : (app1[at] << 8) | app1[at + 1]);
  const u32 = (at: number) =>
    little
      ? (app1[at] | (app1[at + 1] << 8) | (app1[at + 2] << 16) | (app1[at + 3] << 24)) >>> 0
      : ((app1[at] << 24) | (app1[at + 1] << 16) | (app1[at + 2] << 8) | app1[at + 3]) >>> 0;

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > app1.length) return;
  const count = u16(ifd0);

  for (let e = 0; e < count; e++) {
    const entry = ifd0 + 2 + e * 12;
    if (entry + 12 > app1.length) return;
    if (u16(entry) !== ORIENTATION_TAG) continue;
    // Тип SHORT — значение лежит прямо в поле, по смещению +8.
    if (little) {
      app1[entry + 8] = 1;
      app1[entry + 9] = 0;
    } else {
      app1[entry + 8] = 0;
      app1[entry + 9] = 1;
    }
    return;
  }
}

/** Вставляет APP1 сразу за SOI. Если JPEG неопознан — возвращает исходный без изменений. */
export function spliceExifIntoJpeg(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== SOI) return jpeg;
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToJpegDataUrl(bytes: Uint8Array): string {
  let bin = "";
  // Порциями: apply на массиве в несколько мегабайт упирается в лимит аргументов.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

/** Переносит метаданные оригинала в сжатый JPEG. Не вышло — отдаём сжатый как есть. */
export function carryOverExif(originalDataUrl: string, compressedJpegDataUrl: string): string {
  try {
    const app1 = extractExifApp1(dataUrlToBytes(originalDataUrl));
    if (!app1) return compressedJpegDataUrl;
    setOrientationUpright(app1);
    return bytesToJpegDataUrl(spliceExifIntoJpeg(dataUrlToBytes(compressedJpegDataUrl), app1));
  } catch {
    // Метаданные — приятное дополнение, а не условие загрузки: фото должно уйти в любом случае.
    return compressedJpegDataUrl;
  }
}

export async function compressImage(file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);

  try {
    return carryOverExif(dataUrl, await toJpeg(dataUrl));
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
