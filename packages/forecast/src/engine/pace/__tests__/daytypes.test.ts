import { describe, expect, test } from "bun:test";
import { cyclicMerges, partitionId } from "../daytypes";
import { fitPaceModel } from "../index";
import { at, DAY_BUCKETS, makeSeries, rng } from "./synth";

const LONG = 120_000;
const singletons = [[0], [1], [2], [3], [4], [5], [6]];

describe("weekday partitions", () => {
	test("merges are of two adjacent groups only, cyclically (Sun+Mon yes, Mon+Wed never directly)", () => {
		const ids = cyclicMerges(singletons).map(partitionId);
		expect(ids).toHaveLength(7);
		expect(ids).toContain("merged:Tue|Wed|Thu|Fri|Sat|SunMon");
		expect(ids).toContain("merged:MonTue|Wed|Thu|Fri|Sat|Sun");
		expect(ids.some((id) => /MonWed|WedMon/.test(id))).toBe(false);
		const two = cyclicMerges([
			[0, 1, 2, 3, 4],
			[5, 6],
		]).map(partitionId);
		expect(two).toEqual(["merged:MonTueWedThuFriSatSun"]);
	});
	test("partition ids order groups Mon first and concatenate weekdays", () => {
		expect(partitionId([[0], [1, 2, 3, 4], [5, 6]])).toBe(
			"merged:Mon|TueWedThuFri|SatSun",
		);
		expect(
			partitionId([
				[1, 2, 3, 4],
				[5, 6, 0],
			]),
		).toBe("merged:TueWedThuFri|SatSunMon");
	});
});

/** Weekday levels with independent noise; weekday index 0 = Monday. */
const byWeekday = (levels: number[], seed: number, days = 43) => {
	const r = rng(seed);
	return makeSeries(days, (i) => {
		const wd = Math.floor(i / DAY_BUCKETS) % 7;
		return (levels[wd] as number) * (0.6 + 0.8 * r());
	});
};
const entry = (
	s: ReturnType<typeof fitPaceModel>,
	partition: string,
): { loss: number; se: number; groups: number } => {
	const e = s.dayTypeComparison.find((c) => c.partition === partition);
	if (!e) throw new Error(`no ${partition}`);
	return e;
};

describe("dayTypeComparison", () => {
	test(
		"always scores present, one and workday-weekend, plus one merged partition",
		() => {
			const s = fitPaceModel(
				byWeekday([30, 10, 10, 10, 10, 2, 2], 1),
				at(42, 0),
			);
			const ids = s.dayTypeComparison.map((c) => c.partition);
			expect(ids.slice(0, 3)).toEqual(["present", "one", "workday-weekend"]);
			expect(ids).toHaveLength(4);
			expect(ids[3]).toMatch(/^merged:/);
			expect(entry(s, "present").groups).toBe(3);
			expect(entry(s, "one").groups).toBe(1);
			expect(entry(s, "workday-weekend").groups).toBe(2);
		},
		LONG,
	);

	test(
		"weekday groups that differ as the present day types: present scores best",
		() => {
			const s = fitPaceModel(
				byWeekday([30, 10, 10, 10, 10, 2, 2], 1),
				at(42, 0),
			);
			const present = entry(s, "present");
			for (const c of s.dayTypeComparison)
				expect(present.loss).toBeLessThanOrEqual(c.loss + 1e-12);
			expect(entry(s, "one").loss - present.loss).toBeGreaterThan(
				entry(s, "one").se,
			);
			expect(entry(s, "workday-weekend").loss - present.loss).toBeGreaterThan(
				entry(s, "workday-weekend").se,
			);
		},
		LONG,
	);

	test(
		"all days alike: one group is within 1 SE of the best",
		() => {
			const s = fitPaceModel(
				byWeekday([10, 10, 10, 10, 10, 10, 10], 2),
				at(42, 0),
			);
			const best = Math.min(...s.dayTypeComparison.map((c) => c.loss));
			const one = entry(s, "one");
			expect(one.loss - best).toBeLessThanOrEqual(one.se);
		},
		LONG,
	);

	test(
		"the merge runs across the week boundary: Sun and Mon alike join",
		() => {
			const s = fitPaceModel(
				byWeekday([30, 10, 10, 10, 10, 10, 30], 3),
				at(42, 0),
			);
			const merged = s.dayTypeComparison[3]?.partition ?? "";
			expect(merged.replace(/^merged:/, "").split("|")).toContain("SunMon");
		},
		LONG,
	);
});
