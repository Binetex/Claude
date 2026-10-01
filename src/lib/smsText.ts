/**
 * Текст SMS клиенту — только базовым SMS-алфавитом (GSM-7), чтобы платить за 160 знаков, а не 70.
 *
 * Quo берёт $0.01 за каждую часть SMS, отправленной через API. Часть — 160 знаков, пока в тексте
 * нет НИ ОДНОГО символа вне GSM-7. Один фигурный апостроф ’, эмодзи или «á» в имени переводят всё
 * сообщение в Unicode, где часть — 70 знаков: текст в 300 знаков стоит 5 частей вместо 2.
 * Владелец 01.10.2026: «очищать текст в одном месте перед отправкой» — это место `quo/send.ts`.
 *
 * Клиент разницы не видит: ’ → ', “ ” → ", … → ..., á → a, длинное тире — как решил владелец для
 * ИИ (диапазон цифр «2–4 PM» — дефис, остальное — запятая), эмодзи — нет. Буквы других алфавитов
 * (кириллица, иероглифы) не трогаем: их не заменить без потери смысла, а клиенту и так пишем
 * только по-английски.
 */

/** Базовая таблица GSM 03.38: каждый символ — один знак из 160. */
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** Расширение GSM: тоже без Unicode, но каждый символ занимает два знака. */
const GSM_EXT = new Set("^{}\\[~]|€");

const isGsmChar = (ch: string) => GSM_BASIC.has(ch) || GSM_EXT.has(ch);

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!isGsmChar(ch)) return false;
  return true;
}

/** Сколько частей SMS займёт текст — столько и центов возьмёт Quo за отправку через API. */
export function smsSegments(text: string): { encoding: "GSM-7" | "UCS-2"; segments: number } {
  if (!text) return { encoding: "GSM-7", segments: 0 };
  if (isGsm7(text)) {
    let septets = 0;
    for (const ch of text) septets += GSM_EXT.has(ch) ? 2 : 1;
    return { encoding: "GSM-7", segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  // UCS-2 считает в 16-битных единицах: эмодзи — две.
  return { encoding: "UCS-2", segments: text.length <= 70 ? 1 : Math.ceil(text.length / 67) };
}

/**
 * Длинные тире наружу не уходят (решение владельца): модель их любит, и инструкцией одной это
 * не лечится. Диапазон цифр «2–4 PM» остаётся диапазоном через дефис, остальное — запятая.
 */
export function stripDashes(text: string): string {
  return text
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, "$1-")
    .replace(/\s*[—–]+\s*(?=[.,!?;:])/g, "")
    .replace(/^\s*[—–]+\s*/gm, "")
    .replace(/\s*[—–]+\s*$/gm, "")
    .replace(/\s*[—–]+\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** Эмодзи целиком: картинка, оттенок кожи, флаг, «склейка» и селектор вида. */
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{20E3}\u{FE0E}\u{FE0F}\u{200D}]/gu;

/** Типографика, которую клиент не отличит от простых знаков. */
const PUNCT: [RegExp, string][] = [
  [/[‘’‚‛′`´‹›]/g, "'"],
  [/[“”„‟″«»]/g, '"'],
  [/…/g, "..."],
  [/[\u{2010}-\u{2012}\u{2212}\u{2043}]/gu, "-"],
  [/\u{2015}/gu, "—"],
  [/[•‣◦∙·]/g, "-"],
  [/×/g, "x"],
  [/÷/g, "/"],
  [/½/g, "1/2"],
  [/¼/g, "1/4"],
  [/¾/g, "3/4"],
  [/[\u{00A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}\t]/gu, " "],
  [/[\u{00AD}\u{200B}\u{200C}\u{2060}\u{FEFF}]/gu, ""],
  [/[\u{2028}\u{2029}]/gu, "\n"],
  [/\r\n?/g, "\n"],
];

/** Латинские буквы, которые не раскладываются на «букву + знак» (ł, œ). */
const LETTERS: Record<string, string> = {
  ł: "l", Ł: "L", đ: "d", Đ: "D", ð: "d", Ð: "D", þ: "th", Þ: "Th", œ: "oe", Œ: "OE",
  ı: "i", ŧ: "t", Ŧ: "T", ħ: "h", Ħ: "H", ŋ: "n", Ŋ: "N", ſ: "s",
};

/** Буква вне GSM → без диакритики (á → a, ç → c); ä, é, ñ, ü есть в GSM и остаются. */
function toGsmLetter(ch: string): string {
  if (isGsmChar(ch)) return ch;
  if (LETTERS[ch]) return LETTERS[ch];
  const bare = ch.normalize("NFD").replace(/[\u{0300}-\u{036F}]/gu, "");
  return bare && bare !== ch && isGsm7(bare) ? bare : ch;
}

export function toSmsText(text: string): string {
  let out = text.normalize("NFC").replace(EMOJI, "");
  for (const [re, to] of PUNCT) out = out.replace(re, to);
  out = Array.from(stripDashes(out), toGsmLetter).join("");
  return out
    .replace(/ {2,}/g, " ")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/ +$/gm, "")
    .replace(/^ +/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
