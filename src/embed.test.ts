import { test, expect } from "bun:test";
import { fitToSchema } from "./embed.js";

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return dot / (norm(a) * norm(b));
};

test("a vector already at schema size is returned unchanged", () => {
  const v = [0.1, 0.2, 0.3];
  expect(fitToSchema(v, 3)).toBe(v);
});

test("a shorter vector is zero-padded to schema size", () => {
  expect(fitToSchema([1, 2], 4)).toEqual([1, 2, 0, 0]);
});

test("zero-padding preserves cosine similarity", () => {
  const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  const b = Array.from({ length: 768 }, (_, i) => Math.cos(i * 0.7));
  expect(cosine(fitToSchema(a, 1536), fitToSchema(b, 1536))).toBeCloseTo(cosine(a, b), 12);
});

test("a longer vector is rejected with a clear error", () => {
  expect(() => fitToSchema([1, 2, 3], 2)).toThrow(/3 dims but the schema holds 2/);
});
