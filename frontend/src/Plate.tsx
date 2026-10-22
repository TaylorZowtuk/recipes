// A recipe's round plate. Until the recipe has a photo it is an empty plate with the title's
// initial, which is decoration: the title is always written beside it.
export function Plate({ title, size }: { title: string; size: "card" | "hero" }) {
  const initial = Array.from(title.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <span className={`plate plate-${size}`} aria-hidden="true">
      <span className="plate-initial">{initial}</span>
    </span>
  );
}
