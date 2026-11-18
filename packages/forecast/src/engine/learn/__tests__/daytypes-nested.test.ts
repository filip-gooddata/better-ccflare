import { describe, expect, it } from "bun:test";
import { at, makeSeries } from "../../pace/__tests__/synth";
import { floorOf } from "../../pace/fit";
import type { PaceFitState } from "../../pace/types";
import { learnDaytypes } from "../index";
import { PRESENT_PARTITION, partitionKey } from "../partition";
import { scoreDaytypes } from "../rows/daytypes";
import type { LearnInput, Partition } from "../types";

const MON_FRI: Partition = [0, 0, 0, 0, 0, 1, 1];
const P = partitionKey(PRESENT_PARTITION);
const X = partitionKey(MON_FRI);
const WEEKS = Array.from({ length: 10 }, (_, k) => -1 - k);

type Losses = Record<string, number[]>;

/** Present worse than MON_FRI on every week; every other family member worse still. */
const FAMILY: Losses = {
	[P]: WEEKS.map((_, k) => 5 + (k % 3)),
	[X]: WEEKS.map(() => 1),
};
const lossOf = (l: Losses, key: string) =>
	l[key] ?? WEEKS.map((_, k) => 9 + (k % 2));

function fake(family: Losses, nested: Losses, weeks = WEEKS) {
	const fits: string[] = [];
	const nestedCalls: string[] = [];
	const input = {
		series: makeSeries(70, () => 1),
		now: at(69, 12),
		workDays: 5,
		historyLookbackDays: 84,
		historyHalfLifeDays: 14,
		workStartSharePct: 5,
		timeShiftMin: 30,
		fitWithPartition: (p: Partition) => {
			const key = partitionKey(p);
			fits.push(key);
			return {
				oof: { units: WEEKS, loss: lossOf(family, key) },
			} as unknown as PaceFitState;
		},
		nestedLoss: (p: Partition) => {
			const key = partitionKey(p);
			nestedCalls.push(key);
			return { units: weeks, loss: lossOf(nested, key).slice(0, weeks.length) };
		},
	} as LearnInput;
	return { input, fits, nestedCalls };
}

describe("row 1 nested confirmation (R3-2)", () => {
	it("an unnested switch to X stores X as pending and keeps serving the present partition", () => {
		const { input, nestedCalls } = fake(FAMILY, {});
		const r = learnDaytypes(input, {
			served: PRESENT_PARTITION,
			pending: null,
		});
		expect(r.nested).toBe(false);
		expect(r.choice.on).toBe(true);
		expect(partitionKey(r.choice.chosen)).toBe(X);
		expect(partitionKey(r.choice.served)).toBe(P);
		expect(r.pending && partitionKey(r.pending)).toBe(X);
		expect(nestedCalls).toEqual([]);
	});

	it("already serving a confirmed X that the family still picks: keeps X, nothing pending", () => {
		const { input } = fake(FAMILY, {});
		const r = learnDaytypes(input, { served: MON_FRI, pending: null });
		expect(r.nested).toBe(false);
		expect(partitionKey(r.choice.served)).toBe(X);
		expect(r.pending).toBeNull();
	});

	it("an unnested result without a switch serves present and stores nothing", () => {
		const flat: Losses = { [P]: WEEKS.map(() => 1), [X]: WEEKS.map(() => 1) };
		const { input } = fake(flat, {});
		const r = learnDaytypes(input, {
			served: PRESENT_PARTITION,
			pending: null,
		});
		expect(r.choice.on).toBe(false);
		expect(partitionKey(r.choice.served)).toBe(P);
		expect(r.pending).toBeNull();
	});

	it("with X pending: runs only the nested present-vs-X comparison and switches when it passes", () => {
		const { input, fits, nestedCalls } = fake(FAMILY, FAMILY);
		const m = scoreDaytypes(fake(FAMILY, {}).input).candidates.length;
		const r = learnDaytypes(input, {
			served: PRESENT_PARTITION,
			pending: MON_FRI,
		});
		expect(fits).toEqual([]);
		expect(nestedCalls.sort()).toEqual([P, X].sort());
		expect(r.nested).toBe(true);
		expect(r.pending).toBeNull();
		expect(r.choice.on).toBe(true);
		expect(partitionKey(r.choice.served)).toBe(X);
		expect(partitionKey(r.choice.present)).toBe(P);
		// the family's m and floor, not the two candidates'
		expect(r.choice.m).toBe(m);
		expect(r.choice.floor).toBe(floorOf(m));
		expect(r.choice.units).toBe(WEEKS.length);
	});

	it("with X pending and a nested comparison that fails: no switch, pending cleared", () => {
		const even: Losses = { [P]: WEEKS.map(() => 1), [X]: WEEKS.map(() => 1) };
		const { input } = fake(FAMILY, even);
		const r = learnDaytypes(input, {
			served: PRESENT_PARTITION,
			pending: MON_FRI,
		});
		expect(r.nested).toBe(true);
		expect(r.pending).toBeNull();
		expect(r.choice.on).toBe(false);
		expect(partitionKey(r.choice.served)).toBe(P);
	});

	it("nested gains on fewer weeks than the family floor do not switch, though two candidates would", () => {
		const m = scoreDaytypes(fake(FAMILY, {}).input).candidates.length;
		const n = floorOf(m) - 1;
		expect(n).toBeGreaterThanOrEqual(floorOf(2));
		const { input } = fake(FAMILY, FAMILY, WEEKS.slice(0, n));
		const r = learnDaytypes(input, {
			served: PRESENT_PARTITION,
			pending: MON_FRI,
		});
		expect(r.choice.reason).toBe("below-floor");
		expect(partitionKey(r.choice.served)).toBe(P);
		expect(r.pending).toBeNull();
	});

	it("a failed nested comparison keeps an earlier confirmed partition served", () => {
		const even: Losses = { [P]: WEEKS.map(() => 1), [X]: WEEKS.map(() => 1) };
		const OTHER: Partition = [0, 0, 0, 0, 1, 2, 2];
		const { input } = fake(FAMILY, even);
		const r = learnDaytypes(input, { served: OTHER, pending: MON_FRI });
		expect(r.nested).toBe(true);
		expect(partitionKey(r.choice.served)).toBe(partitionKey(OTHER));
	});
});
