export type Line = { id: string; component: string | null; text: string };

export type ComponentGroup<T extends Line> = {
  /** The Component's name, or null for a recipe's unnamed part. */
  component: string | null;
  /** The 1-based position of the group's first line, so step numbers run on across groups. */
  start: number;
  lines: T[];
};

// Ingredient lines or steps split wherever their Component changes, so each group gets a heading.
export function byComponent<T extends Line>(lines: T[]): ComponentGroup<T>[] {
  const groups: ComponentGroup<T>[] = [];
  lines.forEach((line, index) => {
    const last = groups.at(-1);
    if (last && last.component === line.component) last.lines.push(line);
    else groups.push({ component: line.component, start: index + 1, lines: [line] });
  });
  return groups;
}
