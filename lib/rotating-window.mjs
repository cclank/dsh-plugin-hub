export function selectRotatingWindow(candidates, cursor, limit) {
  if (!candidates.length || limit <= 0) return { selected: [], nextCursor: 0 };
  const start = Math.max(0, Math.floor(cursor || 0)) % candidates.length;
  const count = Math.min(Math.floor(limit), candidates.length);
  const selected = Array.from(
    { length: count },
    (_, offset) => candidates[(start + offset) % candidates.length],
  );
  return {
    selected,
    nextCursor: candidates.length > count ? (start + count) % candidates.length : 0,
  };
}
