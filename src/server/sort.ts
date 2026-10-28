const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/** Comparación alfabética en español: "Álvarez" va con la A, no al final. */
export function alphaCompare(a: string, b: string): number {
  return collator.compare(a.trim(), b.trim());
}
