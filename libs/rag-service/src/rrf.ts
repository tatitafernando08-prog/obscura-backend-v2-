export function rrf<T>(
  rankedLists: T[][],
  idOf: (item: T) => string,
  k = 60,
): T[] {
  const scoreById = new Map<string, number>();
  const itemById = new Map<string, T>();

  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const id = idOf(item);
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      scoreById.set(id, (scoreById.get(id) ?? 0) + contribution);
      if (!itemById.has(id)) itemById.set(id, item);
    });
  }

  return [...scoreById.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => itemById.get(id) as T);
}
