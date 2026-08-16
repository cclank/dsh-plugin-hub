import assert from "node:assert/strict";
import test from "node:test";

import { selectRotatingWindow } from "../lib/rotating-window.mjs";

test("rotates bounded discovery windows without starving later candidates", () => {
  const candidates = Array.from({ length: 95 }, (_, index) => `repo-${index}`);
  const first = selectRotatingWindow(candidates, 0, 40);
  const second = selectRotatingWindow(candidates, first.nextCursor, 40);
  const third = selectRotatingWindow(candidates, second.nextCursor, 40);

  assert.deepEqual(first.selected, candidates.slice(0, 40));
  assert.deepEqual(second.selected, candidates.slice(40, 80));
  assert.deepEqual(third.selected, [...candidates.slice(80), ...candidates.slice(0, 25)]);
  assert.equal(third.nextCursor, 25);
  assert.equal(new Set([...first.selected, ...second.selected, ...third.selected]).size, 95);
});

test("returns all candidates and resets the cursor when the window covers the set", () => {
  assert.deepEqual(selectRotatingWindow(["a", "b"], 1, 40), {
    selected: ["b", "a"],
    nextCursor: 0,
  });
  assert.deepEqual(selectRotatingWindow([], 99, 40), { selected: [], nextCursor: 0 });
});
