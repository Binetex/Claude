import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractExifApp1, setOrientationUpright, spliceExifIntoJpeg, carryOverExif } from "./imageCompress";

/**
 * Подготовка фото перед отправкой. Проверяется главное свойство: НАРУЖУ ВСЕГДА УХОДИТ JPEG,
 * каким бы ни был исходник. От этого зависит, откроется ли фотография у клиента — HEIC не
 * покажет ни Android, ни половина почтовых клиентов.
 *
 * Браузерных API в тестовой среде нет, поэтому FileReader, Image и canvas подменяются: их
 * поведение и есть то, что мы описываем — «Safari рисует HEIC сам», «Chrome не умеет».
 */
const JPEG_DATA_URL = "data:image/jpeg;base64,AAAA";

type ImageBehaviour = "draws" | "fails";
let imageBehaviour: ImageBehaviour = "draws";
const convertMock = vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" }));

vi.mock("heic2any", () => ({ default: (...args: unknown[]) => convertMock(...(args as [])) }));

class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() {
    this.result = "data:application/octet-stream;base64,AAAA";
    queueMicrotask(() => this.onload?.());
  }
}

class FakeImage {
  width = 2400;
  height = 1200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => (imageBehaviour === "draws" ? this.onload?.() : this.onerror?.()));
  }
}

beforeEach(() => {
  imageBehaviour = "draws";
  convertMock.mockClear();
  vi.stubGlobal("FileReader", FakeFileReader);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => JPEG_DATA_URL,
    }),
  });
});

afterEach(() => vi.unstubAllGlobals());

const fileOf = (name: string, type: string) => ({ name, type }) as unknown as File;

describe("подготовка фото", () => {
  it("обычный снимок перекодируется в JPEG", async () => {
    const { compressImage } = await import("./imageCompress");
    expect(await compressImage(fileOf("photo.jpg", "image/jpeg"))).toBe(JPEG_DATA_URL);
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("HEIC, который браузер рисует сам (Safari), конвертером не трогается", async () => {
    // Лишняя конвертация — это лишний мегабайт кода и лишние секунды на телефоне.
    const { compressImage } = await import("./imageCompress");
    expect(await compressImage(fileOf("IMG_1.HEIC", "image/heic"))).toBe(JPEG_DATA_URL);
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("HEIC там, где браузер не умеет (Android), конвертируется и всё равно даёт JPEG", async () => {
    imageBehaviour = "fails";
    const { compressImage } = await import("./imageCompress");
    // После конвертации картинку снова надо нарисовать — к этому моменту это уже JPEG.
    const original = FakeImage.prototype;
    let call = 0;
    vi.stubGlobal(
      "Image",
      class {
        width = 2400;
        height = 1200;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          const fails = call++ === 0;
          queueMicrotask(() => (fails ? this.onerror?.() : this.onload?.()));
        }
      }
    );
    void original;

    expect(await compressImage(fileOf("IMG_2.HEIC", ""))).toBe(JPEG_DATA_URL);
    expect(convertMock).toHaveBeenCalledTimes(1);
  });

  it("неизвестный формат объясняется словами, а не падает молча", async () => {
    imageBehaviour = "fails";
    const { compressImage } = await import("./imageCompress");
    await expect(compressImage(fileOf("scan.tiff", "image/tiff"))).rejects.toThrow(/не поддерживается/);
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("сломанный HEIC не уходит в хранилище — конвертер отказал, значит отказ и наружу", async () => {
    imageBehaviour = "fails";
    convertMock.mockRejectedValueOnce(new Error("broken"));
    const { compressImage } = await import("./imageCompress");
    await expect(compressImage(fileOf("broken.heic", "image/heic"))).rejects.toThrow(/HEIC/);
  });
});

/**
 * Перенос EXIF в сжатый JPEG. Проверяется байтовая часть — она чистая и от браузера не зависит.
 *
 * Собираем настоящий минимальный JPEG: SOI, сегмент APP1 с TIFF-блоком и одним тегом
 * Orientation = 6 («повернуть на 90°»), затем SOS и EOI. Именно такой снимок и отдаёт телефон,
 * когда его держат боком.
 */
describe("EXIF переносится в сжатый файл", () => {
  /** APP1 с одним тегом Orientation. Порядок байт — little endian, как у большинства камер. */
  function makeApp1(orientation: number): Uint8Array {
    const tiff = [
      0x49, 0x49, 0x2a, 0x00, // "II", 42
      0x08, 0x00, 0x00, 0x00, // IFD0 по смещению 8
      0x01, 0x00, // одна запись
      0x12, 0x01, // тег 0x0112 Orientation
      0x03, 0x00, // тип SHORT
      0x01, 0x00, 0x00, 0x00, // количество 1
      orientation, 0x00, 0x00, 0x00, // значение
      0x00, 0x00, 0x00, 0x00, // следующего IFD нет
    ];
    const len = 2 + 6 + tiff.length;
    return new Uint8Array([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
  }

  const withExif = (o = 6) => new Uint8Array([0xff, 0xd8, ...makeApp1(o), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const noExif = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const toDataUrl = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;

  it("сегмент EXIF находится в снимке с телефона", () => {
    const app1 = extractExifApp1(withExif());
    expect(app1).not.toBeNull();
    expect(app1![0]).toBe(0xff);
    expect(app1![1]).toBe(0xe1);
  });

  it("в файле без EXIF ничего не выдумывается", () => {
    expect(extractExifApp1(noExif())).toBeNull();
  });

  it("не-JPEG отвергается молча", () => {
    expect(extractExifApp1(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("ориентация обнуляется: canvas уже развернул картинку", () => {
    const app1 = makeApp1(6);
    setOrientationUpright(app1);
    // значение тега лежит по смещению +8 внутри записи IFD0
    const valueAt = 10 + 8 + 2 + 8;
    expect(app1[valueAt]).toBe(1);
  });

  it("сегмент встаёт сразу за SOI, картинка не портится", () => {
    const app1 = makeApp1(1);
    const out = spliceExifIntoJpeg(noExif(), app1);
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[2]).toBe(0xff);
    expect(out[3]).toBe(0xe1);
    expect(out.length).toBe(noExif().length + app1.length);
    // хвост исходного файла сохранён целиком
    expect(Array.from(out.subarray(2 + app1.length))).toEqual(Array.from(noExif().subarray(2)));
  });

  it("сквозной перенос: метаданные оказываются в сжатом файле, ориентация выправлена", () => {
    const result = carryOverExif(toDataUrl(withExif(6)), toDataUrl(noExif()));
    const bytes = Uint8Array.from(Buffer.from(result.split(",")[1], "base64"));
    const carried = extractExifApp1(bytes);
    expect(carried).not.toBeNull();
    const valueAt = 10 + 8 + 2 + 8;
    expect(carried![valueAt]).toBe(1);
  });

  it("нет метаданных у оригинала — сжатый файл отдаётся нетронутым", () => {
    const compressed = toDataUrl(noExif());
    expect(carryOverExif(toDataUrl(noExif()), compressed)).toBe(compressed);
  });

  it("мусор вместо оригинала не мешает загрузке фото", () => {
    const compressed = toDataUrl(noExif());
    expect(carryOverExif("data:image/jpeg;base64,!!!не-base64!!!", compressed)).toBe(compressed);
  });
});
