import { floorOf } from "../pace/fit";
import { paceGrammar } from "../pace/grammar";
import {
	normalizePartition,
	PRESENT_PARTITION,
	partitionKey,
} from "./partition";
import type { Partition } from "./types";

/**
 * A block of a refinement needs this many clean days of its weekdays in the
 * window (source §9): E4's evidence floor, floorOf(grammar size) (R3-7).
 */
export const MIN_BLOCK_CLEAN_DAYS = floorOf(paceGrammar().length);

/** Clean (uncensored) complete days per weekday, 0 = Monday. */
export function cleanDaysByWeekday(
	days: readonly { weekday: number; censored: boolean }[],
): number[] {
	const n = [0, 0, 0, 0, 0, 0, 0];
	for (const d of days)
		if (!d.censored) n[d.weekday] = (n[d.weekday] as number) + 1;
	return n;
}

/** Label-invariant distance: weekday pairs whose same-group relation differs. */
export function pairDistance(a: Partition, b: Partition): number {
	let d = 0;
	for (let i = 0; i < 7; i++)
		for (let j = i + 1; j < 7; j++)
			if ((a[i] === a[j]) !== (b[i] === b[j])) d++;
	return d;
}

const groupsOf = (p: Partition): number => new Set(p).size;

/** The groups of a partition as weekday lists, in cyclic order starting from the group holding Monday. */
function cyclicGroups(p: Partition): number[][] {
	// rotate so that the walk starts at a group boundary, then cut into runs
	let s = 0;
	while (s < 7 && p[s] === p[(s + 6) % 7]) s++;
	const start = s === 7 ? 0 : s;
	const runs: number[][] = [];
	for (let k = 0; k < 7; k++) {
		const w = (start + k) % 7;
		const last = runs[runs.length - 1];
		if (last && p[last[0] as number] === p[w]) last.push(w);
		else runs.push([w]);
	}
	return runs;
}

const fromGroups = (groups: number[][]): number[] => {
	const p = new Array<number>(7).fill(0);
	groups.forEach((g, id) => {
		for (const w of g) p[w] = id;
	});
	return normalizePartition(p);
};

/** Every way to cut `n` items in a line into contiguous runs: arrays of run lengths. */
function compositions(n: number): number[][] {
	if (n === 0) return [[]];
	const out: number[][] = [];
	for (let k = 1; k <= n; k++)
		for (const rest of compositions(n - k)) out.push([k, ...rest]);
	return out;
}

/**
 * Row 1's fixed candidate family from the present partition P (DESIGN-F2 §2 row 1):
 * P; every coarsening by merging cyclically adjacent groups of P; every refinement
 * splitting one group of P into contiguous blocks that each hold at least
 * MIN_BLOCK_CLEAN_DAYS clean days of their weekdays. Ordered by the preference
 * (pair distance from P, ties to fewer groups), P first; `preference` is the dense
 * rank of (distance, groups), P = 0.
 */
export function partitionFamily(
	cleanByWeekday: readonly number[],
	present: Partition = PRESENT_PARTITION,
): { candidates: number[][]; presentIndex: number; preference: number[] } {
	const P = cyclicGroups(present);
	const G = P.length;
	const out = new Map<string, number[]>();
	const add = (p: number[]) => {
		const key = partitionKey(p);
		if (!out.has(key)) out.set(key, p);
	};
	add(normalizePartition(present));

	// coarsenings: cut the cycle of G groups into arcs (any rotation), fewer than G arcs
	for (let r = 0; r < G; r++)
		for (const comp of compositions(G)) {
			if (comp.length === G) continue;
			const arcs: number[][] = [];
			let i = r;
			for (const len of comp) {
				const arc: number[] = [];
				for (let k = 0; k < len; k++) arc.push(...(P[(i + k) % G] as number[]));
				arcs.push(arc);
				i += len;
			}
			add(fromGroups(arcs));
		}

	// refinements: one group of P split into contiguous blocks, each block clean enough
	P.forEach((g, gi) => {
		for (const comp of compositions(g.length)) {
			if (comp.length < 2) continue;
			const blocks: number[][] = [];
			let i = 0;
			for (const len of comp) {
				blocks.push(g.slice(i, i + len));
				i += len;
			}
			const clean = (b: number[]) =>
				b.reduce((s, w) => s + (cleanByWeekday[w] ?? 0), 0);
			if (!blocks.every((b) => clean(b) >= MIN_BLOCK_CLEAN_DAYS)) continue;
			add(fromGroups([...P.slice(0, gi), ...blocks, ...P.slice(gi + 1)]));
		}
	});

	const all = [...out.values()];
	const dist = (p: number[]) => pairDistance(present, p);
	const order = all
		.map((p) => ({ p, d: dist(p), g: groupsOf(p), key: partitionKey(p) }))
		.sort((a, b) => a.d - b.d || a.g - b.g || (a.key < b.key ? -1 : 1));
	const preference: number[] = [];
	let rank = 0;
	order.forEach((c, i) => {
		const prev = order[i - 1];
		if (prev && (prev.d !== c.d || prev.g !== c.g)) rank++;
		preference.push(rank);
	});
	return {
		candidates: order.map((c) => c.p),
		presentIndex: 0,
		preference,
	};
}
