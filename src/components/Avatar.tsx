/**
 * Аватарка сотрудника: фото, если оно загружено, иначе кружок с инициалами.
 *
 * Заглушки-картинки нет намеренно. Один и тот же серый силуэт у всех не отличает Настю от
 * Юли, а в шапке аватарка ровно для этого и нужна: подтвердить, под кем ты сидишь. Инициалы
 * с постоянным цветом это делают без единого загруженного файла.
 *
 * Цвет считается из имени, а не выбирается случайно: иначе он менялся бы на каждой
 * перерисовке, и кружок стал бы мельтешить вместо того, чтобы узнаваться.
 */
const COLORS = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-teal-100 text-teal-700",
];

/** Первые буквы имени и фамилии: «Иван Белфорд» → «ИБ», «Настя» → «Н». */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((w) => [...w][0]!.toUpperCase()).join("");
}

function colorOf(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

export function Avatar({ name, src, size = 36 }: { name: string; src?: string | null; size?: number }) {
  const style = { width: size, height: size };
  if (src) {
    // Обычный <img>, а не next/image: файл грузится в рантайме и оптимизатору Next неизвестен,
    // а перебирать его через /_next/image ради кружка 36 пикселей смысла нет.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} style={style} className="shrink-0 rounded-full object-cover ring-1 ring-slate-200" />;
  }
  return (
    <span
      style={{ ...style, fontSize: Math.round(size * 0.38) }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-black/5 ${colorOf(name)}`}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}
