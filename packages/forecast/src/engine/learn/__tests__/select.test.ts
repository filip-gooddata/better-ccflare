import { describe, expect, it } from "bun:test";
import { floorOf } from "../../pace/fit";
import { selectRow } from "../select";
import type { RowScores } from "../types";

interface Cand {
	id: string;
	pref: number;
	loss: number[];
}

const NAN = Number.NaN;

/** Candidate 0 is the present one. */
function row(cands: Cand[], units?: number[]): RowScores<string> {
	const n = Math.max(...cands.map((c) => c.loss.length));
	return {
		row: "r",
		candidates: cands.map((c) => c.id),
		presentIndex: 0,
		preference: cands.map((c) => c.pref),
		units: units ?? Array.from({ length: n }, (_, u) => u),
		loss: cands.map((c) => Float64Array.from(c.loss)),
	};
}

const rep = (n: number, f: (u: number) => number) =>
	Array.from({ length: n }, (_, u) => f(u));
const alt = (n: number, a: number, b: number) =>
	rep(n, (u) => (u % 2 === 0 ? a : b));

/** Present P and a candidate A beating it by about 0.5 on every unit. */
const clear = (n: number): Cand[] => [
	{ id: "P", pref: 0, loss: rep(n, (u) => 1 + 0.01 * (u % 3)) },
	{
		id: "A",
		pref: 1,
		loss: rep(n, (u) => 0.5 + 0.01 * (u % 3) - 0.01 * (u % 2)),
	},
];

describe("selectRow", () => {
	it("keeps the present when it is inside the one-SE set of the best", () => {
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: alt(20, 1.0, 1.2) },
				{ id: "A", pref: 1, loss: alt(20, 0.8, 1.38) },
			]),
		);
		expect(c.chosen).toBe("P");
		expect(c.served).toBe("P");
		expect(c.on).toBe(false);
		expect(c.reason).toBe("present-best");
		expect(c.runnerUp).toBe("A");
		expect(c.gain).toBe(0);
		expect(c.se).toBe(0);
		expect(c.p).toBe(1);
		expect(c.units).toBe(20);
		expect(c.presentLoss).toBeCloseTo(1.1, 12);
		expect(c.chosenLoss).toBeCloseTo(1.1, 12);
	});

	it("switches on a clear winner and reports the present as runner-up", () => {
		const c = selectRow(row(clear(20)));
		expect(c.m).toBe(2);
		expect(c.floor).toBe(floorOf(2));
		expect(c.units).toBe(20);
		expect(c.chosen).toBe("A");
		expect(c.served).toBe("A");
		expect(c.present).toBe("P");
		expect(c.runnerUp).toBe("P");
		expect(c.on).toBe(true);
		expect(c.reason).toBe("on");
		expect(c.gain).toBeCloseTo(0.505, 12);
		expect(c.gain).toBeGreaterThan(c.se);
		expect(c.p).toBeLessThan(0.01);
		expect(c.presentLoss - c.chosenLoss).toBeCloseTo(c.gain, 12);
	});

	it("stays off below the evidence floor", () => {
		const c = selectRow(row(clear(4)));
		expect(floorOf(2)).toBeGreaterThan(4);
		expect(c.chosen).toBe("A");
		expect(c.served).toBe("P");
		expect(c.on).toBe(false);
		expect(c.reason).toBe("below-floor");
		expect(c.units).toBe(4);
	});

	it("stays off when the gain of the chosen candidate does not exceed its SE", () => {
		// B is best; A (preferred) sits in B's one-SE set by its noise but its gain over P is within one SE.
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: rep(20, () => 11) },
				{ id: "A", pref: 1, loss: alt(20, 20, 0.1) },
				{ id: "B", pref: 2, loss: rep(20, () => 10) },
			]),
		);
		expect(c.chosen).toBe("A");
		expect(c.runnerUp).toBe("B");
		expect(c.gain).toBeCloseTo(0.95, 12);
		expect(c.gain).toBeLessThanOrEqual(c.se);
		expect(c.served).toBe("P");
		expect(c.on).toBe(false);
		expect(c.reason).toBe("gain-le-se");
	});

	// d = P - A is +1 on ten units and -1 on two: gain > se, sign-flip p about 0.019.
	const weak: Cand[] = [
		{ id: "P", pref: 0, loss: rep(12, () => 2) },
		{ id: "A", pref: 1, loss: rep(12, (u) => (u < 10 ? 1 : 3)) },
	];

	it("switches a weak winner on when it is the only alternative", () => {
		const c = selectRow(row(weak));
		expect(c.reason).toBe("on");
		expect(c.p).toBeGreaterThan(0.01);
		expect(c.p).toBeLessThan(0.05);
	});

	it("keeps the same weak winner off under BH when many candidates were searched", () => {
		const others = rep(48, (k) => ({
			id: `X${k}`,
			pref: k + 2,
			loss: rep(12, () => 2.5 + 0.01 * k),
		}));
		const c = selectRow(row([...weak, ...others]));
		expect(c.m).toBe(50);
		expect(c.floor).toBe(floorOf(50));
		expect(c.units).toBeGreaterThanOrEqual(c.floor);
		expect(c.chosen).toBe("A");
		expect(c.gain).toBeGreaterThan(c.se);
		expect(c.served).toBe("P");
		expect(c.on).toBe(false);
		expect(c.reason).toBe("bh");
		expect(c.p).toBeGreaterThan(0.01);
	});

	it("chooses the lowest preference rank inside the one-SE set, not the best mean", () => {
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: rep(20, () => 5) },
				{ id: "A", pref: 2, loss: alt(20, 1, 1.2) },
				{ id: "B", pref: 1, loss: alt(20, 1.5, 0.8) },
			]),
		);
		expect(c.chosen).toBe("B");
		expect(c.runnerUp).toBe("A");
		expect(c.chosenLoss).toBeCloseTo(1.15, 12);
	});

	it("breaks a preference tie by the lower mean", () => {
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: rep(20, () => 5) },
				{ id: "C", pref: 1, loss: alt(20, 1.5, 0.8) },
				{ id: "D", pref: 1, loss: alt(20, 1, 1.2) },
				{ id: "E", pref: 2, loss: alt(20, 0.6, 1.5) },
			]),
		);
		expect(c.chosen).toBe("D");
		expect(c.runnerUp).toBe("E");
	});

	it("serves the present with no-units when no unit is scored by every candidate", () => {
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: [1, 1, NAN, NAN] },
				{ id: "A", pref: 1, loss: [NAN, NAN, 0, 0] },
			]),
		);
		expect(c.units).toBe(0);
		expect(c.served).toBe("P");
		expect(c.chosen).toBe("P");
		expect(c.runnerUp).toBeNull();
		expect(c.on).toBe(false);
		expect(c.reason).toBe("no-units");
		expect(c.m).toBe(2);
		expect(c.floor).toBe(floorOf(2));
		expect(c.p).toBe(1);
		expect(c.runnerUpLoss).toBeNaN();
	});

	it("serves the present with no-units for a row with no units at all", () => {
		const c = selectRow({
			row: "stub",
			candidates: [7],
			presentIndex: 0,
			preference: [0],
			units: [],
			loss: [new Float64Array(0)],
		});
		expect(c).toMatchObject({
			row: "stub",
			m: 1,
			floor: floorOf(1),
			units: 0,
			present: 7,
			chosen: 7,
			runnerUp: null,
			served: 7,
			gain: 0,
			se: 0,
			p: 1,
			on: false,
			reason: "no-units",
		});
		expect(c.presentLoss).toBeNaN();
		expect(c.chosenLoss).toBeNaN();
		expect(c.runnerUpLoss).toBeNaN();
	});

	it("serves the present with no-units when the present has no finite loss", () => {
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: rep(20, () => NAN) },
				{ id: "A", pref: 1, loss: rep(20, () => 0.1) },
			]),
		);
		expect(c.served).toBe("P");
		expect(c.reason).toBe("no-units");
		expect(c.units).toBe(0);
	});

	it("drops all-NaN candidates from the search but counts them in m", () => {
		const nanCands = rep(3, (k) => ({
			id: `N${k}`,
			pref: k + 2,
			loss: rep(20, () => NAN),
		}));
		const c = selectRow(row([...clear(20), ...nanCands]));
		expect(c.m).toBe(5);
		expect(c.floor).toBe(floorOf(5));
		expect(c.units).toBe(20);
		expect(c.chosen).toBe("A");
		expect(c.runnerUp).toBe("P");
		expect(c.reason).toBe("on");
	});

	it("scores only the units every kept candidate scored", () => {
		const extra: Cand = {
			id: "C",
			pref: 2,
			loss: rep(20, (u) => (u === 0 || u === 7 ? NAN : 3)),
		};
		const c = selectRow(row([...clear(20), extra]));
		expect(c.units).toBe(18);
		expect(c.runnerUp).toBe("P");
	});

	it("reports the runner-up mean loss on the units every kept candidate scored", () => {
		const extra: Cand = {
			id: "C",
			pref: 2,
			loss: rep(20, (u) => (u === 0 || u === 7 ? NAN : 3)),
		};
		const cands = [...clear(20), extra];
		const c = selectRow(row(cands));
		const pLoss = (cands[0] as Cand).loss;
		const shared = pLoss.filter((_, u) => u !== 0 && u !== 7);
		const sharedMean = shared.reduce((a, b) => a + b, 0) / shared.length;
		const allMean = pLoss.reduce((a, b) => a + b, 0) / pLoss.length;
		expect(c.runnerUp).toBe("P");
		expect(c.runnerUpLoss).toBeCloseTo(sharedMean, 12);
		expect(Math.abs(sharedMean - allMean)).toBeGreaterThan(1e-6);
		expect(c.runnerUpLoss).toBe(c.presentLoss);
	});

	it("reports the runner-up mean loss when the present is kept", () => {
		const c = selectRow(
			row([
				{ id: "P", pref: 0, loss: [1, 2, 3, 4] },
				{ id: "A", pref: 1, loss: [2, 4, 6, 8] },
			]),
		);
		expect(c.chosen).toBe("P");
		expect(c.runnerUp).toBe("A");
		expect(c.runnerUpLoss).toBe(5);
		expect(c.chosenLoss).toBe(2.5);
	});

	it("reports no runner-up loss for a row with a single scored candidate", () => {
		const c = selectRow({
			row: "solo",
			candidates: [7],
			presentIndex: 0,
			preference: [0],
			units: [0, 1, 2],
			loss: [Float64Array.from([1, 2, 3])],
		});
		expect(c.reason).toBe("present-best");
		expect(c.units).toBe(3);
		expect(c.runnerUp).toBeNull();
		expect(c.runnerUpLoss).toBeNaN();
	});
});
