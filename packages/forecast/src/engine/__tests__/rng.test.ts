import { describe, expect, test } from "bun:test";
import { createRng } from "../rng";

function take(seed: string, n: number): number[] {
	const rng = createRng(seed);
	return Array.from({ length: n }, () => rng.uniform());
}

describe("createRng", () => {
	test("same seed, same sequence", () => {
		expect(take("2026-11-12", 50)).toEqual(take("2026-11-12", 50));
	});

	test("another seed, another sequence", () => {
		expect(take("2026-11-13", 50)).not.toEqual(take("2026-11-12", 50));
	});

	test("uniform is in [0, 1) and int in 0..n-1", () => {
		const rng = createRng("range");
		const seen = new Set<number>();
		for (let i = 0; i < 10_000; i++) {
			const u = rng.uniform();
			expect(u).toBeGreaterThanOrEqual(0);
			expect(u).toBeLessThan(1);
			const k = rng.int(7);
			expect(Number.isInteger(k)).toBe(true);
			expect(k).toBeGreaterThanOrEqual(0);
			expect(k).toBeLessThan(7);
			seen.add(k);
		}
		expect(seen.size).toBe(7);
	});

	test("normal has mean about 0 and standard deviation about 1", () => {
		const rng = createRng("normal");
		const n = 50_000;
		let sum = 0;
		let sumSq = 0;
		for (let i = 0; i < n; i++) {
			const x = rng.normal();
			expect(Number.isFinite(x)).toBe(true);
			sum += x;
			sumSq += x * x;
		}
		const mean = sum / n;
		const sd = Math.sqrt(sumSq / n - mean * mean);
		expect(Math.abs(mean)).toBeLessThan(0.02);
		expect(Math.abs(sd - 1)).toBeLessThan(0.02);
	});
});
