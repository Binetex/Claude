import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
