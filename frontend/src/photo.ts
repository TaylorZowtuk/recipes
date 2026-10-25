import type { Preview } from "./api/client";

// A stored photo's full-size copy, and its card-size copy about 400 px wide.
export const imageUrl = (id: string) => `/images/${id}.webp`;
export const cardImageUrl = (id: string) => `/images/${id}-card.webp`;

export type Focal = Pick<Preview, "focal_x" | "focal_y">;

export const clampFraction = (n: number) => Math.min(1, Math.max(0, n));

// Where a pointer is on the photo, as fractions of its width and height. A drag that leaves the
// photo pins the Focal Point to its edge.
export function focalAt(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): Focal {
  return {
    focal_x: clampFraction((clientX - rect.left) / rect.width),
    focal_y: clampFraction((clientY - rect.top) / rect.height),
  };
}

const STEP = 0.05;
const steps: Record<string, [number, number]> = {
  ArrowLeft: [-STEP, 0],
  ArrowRight: [STEP, 0],
  ArrowUp: [0, -STEP],
  ArrowDown: [0, STEP],
};

// The Focal Point after an arrow key, or undefined for any other key.
export function focalStep(focal: Focal, key: string): Focal | undefined {
  const step = steps[key];
  if (!step) return undefined;
  const round = (n: number) => Math.round(clampFraction(n) * 1000) / 1000;
  return { focal_x: round(focal.focal_x + step[0]), focal_y: round(focal.focal_y + step[1]) };
}

// The CSS object-position that keeps the Focal Point in a cover crop of any shape: the point at
// those fractions of the photo lines up with the same fractions of the plate.
export function objectPosition({ focal_x, focal_y }: Focal): string {
  const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
  return `${percent(focal_x)} ${percent(focal_y)}`;
}
