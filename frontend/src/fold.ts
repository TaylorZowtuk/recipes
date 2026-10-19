// A string with its accents stripped and its case folded, so "Crème" and "creme" compare equal.
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
