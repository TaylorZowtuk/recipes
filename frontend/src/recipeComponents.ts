export type Line = { id: string; component: string | null; text: string };

export type ComponentPart<T extends Line> = {
  /** The Component's name, or null for a recipe's unnamed part. */
  component: string | null;
  /** The 1-based position of the part's first line, so step numbers run on across parts. */
  start: number;
  lines: T[];
};

// Ingredient lines or steps split wherever their Component changes, so each part gets a heading.
export function byComponent<T extends Line>(lines: T[]): ComponentPart<T>[] {
  const parts: ComponentPart<T>[] = [];
  lines.forEach((line, index) => {
    const last = parts.at(-1);
    if (last && last.component === line.component) last.lines.push(line);
    else parts.push({ component: line.component, start: index + 1, lines: [line] });
  });
  return parts;
}
