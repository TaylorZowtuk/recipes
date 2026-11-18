import { useState } from "react";
import type { Preview } from "./api/client";
import { cardImageUrl, imageUrl, objectPosition } from "./photo";

// A recipe's round plate: its Preview Photo cropped round about the Focal Point, or the Empty
// Plate with the title's initial, also shown if the photo fails to load. Either is decoration:
// the title is always written beside it. A card's photo loads once it nears the screen. A hero
// whose full-size photo fails, as offline when it isn't cached, shows the card-size copy instead.
export function Plate({
  title,
  size,
  preview,
}: {
  title: string;
  size: "card" | "hero";
  preview: Preview | null;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const sources = !preview
    ? []
    : size === "card"
      ? [cardImageUrl(preview.image_id)]
      : [imageUrl(preview.image_id), cardImageUrl(preview.image_id)];
  const src = sources.find((source) => !failed.includes(source));
  const initial = Array.from(title.trim())[0]?.toLocaleUpperCase() ?? "";
  if (preview && src) {
    return (
      <span className={`plate plate-${size} plate-photo`} aria-hidden="true">
        <img
          src={src}
          alt=""
          draggable={false}
          loading={size === "card" ? "lazy" : "eager"}
          decoding="async"
          style={{ objectPosition: objectPosition(preview) }}
          onError={() => setFailed((failures) => [...failures, src])}
        />
      </span>
    );
  }
  return (
    <span className={`plate plate-${size}`} aria-hidden="true">
      <span className="plate-initial">{initial}</span>
    </span>
  );
}
