import { describe, expect, test } from "bun:test";
import { buildCalendar, groupNames, PRESENT_GROUP } from "../calendar";
import { applyPace, fitPaceModel } from "../index";
import type { PaceFitState, PaceSeries } from "../types";
import { at, DAY_BUCKETS, MON0, makeSeries, plantedLevels } from "./synth";

const LONG = 240_000;

describe("calendar groups", () => {
	test("the default calendar is the present partition", () => {
		const a = buildCalendar(MON0, 14 * DAY_BUCKETS, "UTC");
		const b = buildCalendar(MON0, 14 * DAY_BUCKETS, "UTC", PRESENT_GROUP);
		expect(Array.from(a.dtype)).toEqual(Array.from(b.dtype));
		expect(a.dtype[0]).toBe(1); // Monday
		expect(a.dtype[DAY_BUCKETS]).toBe(0); // Tuesday
		expect(a.dtype[5 * DAY_BUCKETS]).toBe(2); // Saturday
	});
	test("a passed partition sets each bucket's group by its weekday", () => {
		const group = [0, 0, 0, 0, 0, 1, 1];
		const c = buildCalendar(MON0, 7 * DAY_BUCKETS, "UTC", group);
		for (let d = 0; d < 7; d++)
			expect(c.dtype[d * DAY_BUCKETS + 100]).toBe(group[d] as number);
	});
});

describe("groupNames", () => {
	test("present groups keep their names", () => {
		expect(groupNames(PRESENT_GROUP)).toEqual(["workday", "monday", "weekend"]);
		expect(groupNames([0, 1, 1, 1, 1, 2, 2])).toEqual([
			"monday",
			"workday",
			"weekend",
		]);
	});
	test("other groups are named by their weekday block", () => {
		expect(groupNames([0, 0, 0, 0, 0, 1, 1])).toEqual(["mon-fri", "weekend"]);
		expect(groupNames([0, 1, 1, 1, 1, 0, 0])).toEqual(["sat-mon", "workday"]);
		expect(groupNames([0, 1, 1, 1, 1, 1, 1])).toEqual(["monday", "tue-sun"]);
		expect(groupNames([0, 0, 0, 0, 0, 0, 0])).toEqual(["all"]);
		expect(groupNames([0, 1, 2, 2, 2, 3, 4])).toEqual([
			"monday",
			"tue",
			"wed-fri",
			"sat",
			"sun",
		]);
		expect(groupNames([0, 1, 0, 1, 1, 1, 1])).toEqual([
			"mon+wed",
			"tue+thu-sun",
		]);
	});
});

describe("out-of-fold served loss", () => {
	test(
		"a flat history serves the plain line and its baseline is exact: zero loss on every held-out week",
		() => {
			const s = makeSeries(36, () => 10);
			const state = fitPaceModel(s, at(35, 0));
			expect(state.selected.every((b) => b.feature === null)).toBe(true);
			// weeks starting days 0, 7, 14, 21, 28 (unit -1 - week key), ascending
			expect(state.oof?.units.length).toBe(5);
			expect(state.oof?.loss).toEqual([0, 0, 0, 0, 0]);
			const two = fitPaceModel(s, at(35, 0), [0, 0, 0, 0, 0, 1, 1]);
			expect(two.oof).toEqual(state.oof);
		},
		LONG,
	);

	test(
		"with no feature, a week's loss is the sum over every band's test rows of y^2 (hand-checked)",
		() => {
			// week 0 flat at 10, week 1 flat at 20; fitted at day 14 00:00, one group. Each fold's
			// training rows hold one level, so nothing predicts the held-out week's level.
			// Scoring folds leave out every day the held-out week's targets touch:
			// week 1's targets touch days 7..13, so its baseline is days 0..6 (10 per bucket);
			// week 0's reach day 13, so its baseline has no day (0 per bucket).
			const unit = (i: number) => (i < 7 * 288 ? 10 : 20);
			const s = makeSeries(14, unit);
			const state = fitPaceModel(s, at(14, 0), [0, 0, 0, 0, 0, 0, 0]);
			// the hand value assumes every band serves the plain line
			expect(state.selected.every((b) => b.feature === null)).toBe(true);
			// y = log((U + 2) / (B + 2)) over each band's target span [o + from, o + to),
			// origins every 30 min of the week whose target ends by the cut; plain line: loss = y^2
			const edges = [0, 60, 120, 240, 480, 960, 1440, 2880, 5760, 10080].map(
				(m) => m / 5,
			);
			const cut = 14 * 288;
			const want = (from: number, B: number) => {
				let sum = 0;
				for (let k = 0; k < 9; k++)
					for (let o = from; o < from + 7 * 288; o += 6) {
						const a = o + (edges[k] as number);
						const b = o + (edges[k + 1] as number);
						if (b > cut) continue;
						let U = 0;
						for (let i = a; i < b; i++) U += unit(i);
						sum += Math.log((U + 2) / (B * (b - a) + 2)) ** 2;
					}
				return sum;
			};
			// units ascend by -1 - week key: week 1 first, then week 0
			expect(state.oof?.units.length).toBe(2);
			expect(state.oof?.loss[0] as number).toBeCloseTo(want(7 * 288, 10), 6);
			expect(state.oof?.loss[1] as number).toBeCloseTo(want(0, 0), 6);
		},
		LONG,
	);
});

describe("fitPaceModel with a partition", () => {
	let base: { s: PaceSeries; state: PaceFitState } | null = null;
	const planted = () => {
		if (!base) {
			const s = makeSeries(
				39,
				plantedLevels(39, 11, { "37/1": 20, "38/1": 5 }),
			);
			base = { s, state: fitPaceModel(s, at(37, 0)) };
		}
		return base;
	};

	test(
		"the present partition, in any labelling, reproduces today's fit exactly",
		() => {
			const { s, state } = planted();
			expect(fitPaceModel(s, at(37, 0), PRESENT_GROUP)).toEqual(state);
			expect(fitPaceModel(s, at(37, 0), [0, 1, 1, 1, 1, 2, 2])).toEqual(state);
			expect(state.dayTypes).toBeUndefined();
			expect(Object.keys(state.baseline).sort()).toEqual([
				"monday",
				"weekend",
				"workday",
			]);
		},
		LONG,
	);

	test(
		"a two-group partition fits its own groups, and apply serves them",
		() => {
			const { s } = planted();
			const state = fitPaceModel(s, at(37, 0), [0, 0, 0, 0, 0, 1, 1]);
			expect(state.dayTypes).toEqual({
				names: ["mon-fri", "weekend"],
				group: [0, 0, 0, 0, 0, 1, 1],
			});
			expect(Object.keys(state.baseline).sort()).toEqual([
				"mon-fri",
				"weekend",
			]);
			expect(state.cellsTotal).toBe(9 * 2 * 24);
			const cells = state.bands.flatMap((b) => b.cells);
			expect(cells.length).toBeGreaterThan(0);
			for (const c of cells)
				expect(["mon-fri", "weekend"]).toContain(c.dayType);
			// day 37 is a Wednesday: the 08-16 block is high, so the 0-2 h band rises at 10:00
			const now = applyPace(state, s, at(37, 10), true);
			expect(now.status).toBe("fitted");
			expect(now.bands.some((b) => b.m !== 1)).toBe(true);
			// the state stays plain data (the worker posts it by structured clone)
			expect(structuredClone(state)).toEqual(state);
		},
		LONG,
	);
});
