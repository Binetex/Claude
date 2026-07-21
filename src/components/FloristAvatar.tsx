/**
 * Маленькая круглая аватарка флориста (по умолчанию 26×26). Если фото нет — кружок с инициалами.
 * Без "use client": просто разметка. Изображение — обычный <img> (в проекте нет next/image).
 */
export function FloristAvatar({
  name,
  avatarUrl,
  size = 26,
}: {
  name: string | null | undefined;
  avatarUrl?: string | null;
  size?: number;
}) {
  const dim = { width: `${size}px`, height: `${size}px` };

  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={name ?? ""}
        style={dim}
        className="inline-block shrink-0 rounded-full border border-slate-200 object-cover align-middle"
      />
    );
  }

  const initials =
    (name ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "—";

  return (
    <span
      style={{ ...dim, fontSize: `${Math.max(9, Math.round(size * 0.4))}px` }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-600 align-middle"
      aria-hidden
    >
      {initials}
    </span>
  );
}
