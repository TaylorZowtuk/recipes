import { useState } from "react";
import type { Preview } from "./api/client";
import { cardImageUrl, imageUrl, objectPosition } from "./photo";

// A recipe's round plate: its Preview Photo cropped round about the Focal Point, or the Empty
// Plate with the title's initial, also shown if the photo fails to load. Either is decoration:
// the title is always written beside it. A card's photo loads once it nears the screen.
export function Plate({
  title,
  size,
  preview,
}: {
  title: string;
  size: "card" | "hero";
  preview: Preview | null;
}) {
  const [failed, setFailed] = useState<string>();
  const src = preview ? (size === "card" ? cardImageUrl : imageUrl)(preview.image_id) : undefined;
  const initial = Array.from(title.trim())[0]?.toLocaleUpperCase() ?? "";
  if (preview && src !== failed) {
    return (
      <span className={`plate plate-${size} plate-photo`} aria-hidden="true">
        <img
          src={src}
          alt=""
          draggable={false}
          loading={size === "card" ? "lazy" : "eager"}
          decoding="async"
          style={{ objectPosition: objectPosition(preview) }}
          onError={() => setFailed(src)}
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
