export interface RotatingWindow<T> {
  selected: T[];
  nextCursor: number;
}

export function selectRotatingWindow<T>(
  candidates: readonly T[],
  cursor: number,
  limit: number,
): RotatingWindow<T>;
