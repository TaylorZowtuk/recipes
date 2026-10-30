import { type PointerEvent, useEffect, useRef } from "react";
import { type DifficultyChoice, editBlock } from "./addRecipe";
import type { Difficulty, Image, Preview } from "./api/client";
import { useSync } from "./collection";
import { useOnline } from "./online";
import { Plate } from "./Plate";
import { cardImageUrl, type Focal, focalAt, focalStep, imageUrl } from "./photo";

// The fields an editor sets on a recipe, shared by Add a recipe's review and the recipe page's
// Edit: Difficulty, Tags and the Preview Photo with its Focal Point.

export const PAUSED = "Editing is paused while Plateful updates.";

// Why editing is off, if it is: offline, or paused while the API is read-only.
export function useEditBlock() {
  return editBlock(useOnline(), useSync());
}

export function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

const PARTS = [
  ["prep", "Prep"],
  ["cook", "Cook"],
  ["cleanup", "Cleanup"],
] as const satisfies [keyof Difficulty, string][];

// Prep, Cook and Cleanup, each 1–3, and Clear Difficulty once any is rated.
export function DifficultyField({
  difficulty,
  onChange,
}: {
  difficulty: DifficultyChoice;
  onChange: (difficulty: DifficultyChoice) => void;
}) {
  return (
    <fieldset className="difficulty-field">
      <legend>Difficulty</legend>
      <p className="field-hint">Optional. 1 is easy, 3 is hard.</p>
      {PARTS.map(([part, label]) => (
        <fieldset key={part} className="rating">
          <legend>{label}</legend>
          <div className="segments">
            {[1, 2, 3].map((n) => (
              <label key={n}>
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`difficulty-${part}`}
                  checked={difficulty[part] === n}
                  onChange={() => onChange({ ...difficulty, [part]: n })}
                />
                <span>{n}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {Object.keys(difficulty).length > 0 && (
        <button type="button" className="text-button" onClick={() => onChange({})}>
          Clear Difficulty
        </button>
      )}
    </fieldset>
  );
}

// Tags as one comma-separated line.
export function TagsField({ tags, onChange }: { tags: string; onChange: (tags: string) => void }) {
  return (
    <>
      <label htmlFor="recipe-tags">Tags</label>
      <p id="recipe-tags-hint" className="field-hint">
        Optional. Separate tags with commas.
      </p>
      <input
        id="recipe-tags"
        className="text-input"
        aria-describedby="recipe-tags-hint"
        autoComplete="off"
        value={tags}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}

// The Preview Photo: one of the stored images, or No photo for the Empty Plate. `storing` more
// show as placeholders until they arrive. A chosen photo gets its Focal Point picker below.
export function PhotoPicker({
  title,
  images,
  storing = 0,
  emptyText = "No photos were found.",
  preview,
  onPick,
}: {
  title: string;
  images: Image[];
  storing?: number;
  emptyText?: string;
  preview: Preview | null | undefined;
  onPick: (preview: Preview | null) => void;
}) {
  const chosen = preview && images.find((image) => image.id === preview.image_id);
  return (
    <fieldset className="photo-picker">
      <legend>Photo</legend>
      <p role="status" className="field-hint">
        {storing > 0
          ? "Getting the photos…"
          : images.length === 0
            ? emptyText
            : images.length === 1
              ? "1 photo"
              : `${images.length} photos`}
      </p>
      <div className="photo-options">
        <label className="photo-option">
          <input
            type="radio"
            className="visually-hidden"
            name="photo"
            checked={preview === null}
            onChange={() => onPick(null)}
          />
          <span className="photo-swatch photo-none" />
          <span className="photo-option-label">No photo</span>
        </label>
        {images.map((image, i) => (
          <label key={image.id} className="photo-option">
            <input
              type="radio"
              className="visually-hidden"
              name="photo"
              aria-label={`Photo ${i + 1}`}
              checked={preview?.image_id === image.id}
              onChange={() => onPick({ image_id: image.id, focal_x: 0.5, focal_y: 0.5 })}
            />
            <span className="photo-swatch">
              <img src={cardImageUrl(image.id)} alt="" draggable={false} />
            </span>
          </label>
        ))}
        {Array.from({ length: storing }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to key on.
          <span key={i} className="photo-swatch photo-storing" aria-hidden="true" />
        ))}
      </div>
      {preview && chosen && (
        <FocalPointPicker
          title={title}
          image={chosen}
          focal={preview}
          onChange={(focal) => onPick({ image_id: chosen.id, ...focal })}
        />
      )}
    </fieldset>
  );
}

// The chosen photo, whole, with the Focal Point on it. Dragging with a finger or a mouse moves
// it, and so do the arrow keys once it has focus. A small plate at its corner shows the round crop,
// so it stays in view while dragging.
function FocalPointPicker({
  title,
  image,
  focal,
  onChange,
}: {
  title: string;
  image: Image;
  focal: Focal;
  onChange: (focal: Focal) => void;
}) {
  const across = Math.round(focal.focal_x * 100);
  const down = Math.round(focal.focal_y * 100);
  const move = (event: PointerEvent<HTMLDivElement>) =>
    onChange(focalAt(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect()));
  return (
    <div className="focal">
      <p id="focal-hint" className="field-hint">
        Drag on the photo, or use the arrow keys, to choose the Focal Point the plate keeps in view.
      </p>
      <div className="focal-stage">
        <div
          className="focal-frame"
          role="slider"
          tabIndex={0}
          aria-label="Focal Point"
          aria-describedby="focal-hint"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={across}
          aria-valuetext={`${across}% across, ${down}% down`}
          style={{
            aspectRatio: `${image.width} / ${image.height}`,
            width: `min(100%, calc(60vh * ${image.width / image.height}))`,
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            move(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);
          }}
          onKeyDown={(event) => {
            const next = focalStep(focal, event.key);
            if (!next) return;
            event.preventDefault();
            onChange(next);
          }}
        >
          <img src={imageUrl(image.id)} alt="" draggable={false} />
          <span
            className="focal-marker"
            style={{ left: `${focal.focal_x * 100}%`, top: `${focal.focal_y * 100}%` }}
          />
        </div>
        <span className="focal-plate">
          <Plate title={title} size="card" preview={{ image_id: image.id, ...focal }} />
        </span>
      </div>
    </div>
  );
}
