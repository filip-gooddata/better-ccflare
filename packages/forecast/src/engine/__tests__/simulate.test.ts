import { describe, expect, test } from "bun:test";
import {
	buildSampleAxis,
	onDemandPlan,
	type SimPlan,
	simulate,
} from "../simulate";
import {
	account,
	HOUR,
	indexAt,
	MIN,
	makeCtx,
	measureYield,
	prague,
	session,
} from "./fixtures-sim";

describe("buildSampleAxis", () => {
	test("5-minute steps on the clock to fineEnd, hourly to simEnd, jumps twice", () => {
		const now = prague(12, 8, 2, 30);
		const reset = prague(12, 10, 17, 41);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [account({ id: "acct-a", fiveUsed: 10, fiveReset: reset })],
			rate: () => 0,
		});
		const { times } = buildSampleAxis(ctx, onDemandPlan(ctx));
		expect(times[0]).toBe(now);
		expect(times[1]).toBe(prague(12, 8, 5));
		expect(times[2]).toBe(prague(12, 8, 10));
		expect(times.filter((t) => t === reset)).toHaveLength(2);
		expect(times).toContain(ctx.horizon.fineEnd);
		const afterFine = times.filter((t) => t > ctx.horizon.fineEnd);
		expect(afterFine[0] % HOUR).toBe(0);
		expect(times[times.length - 1]).toBe(ctx.horizon.simEnd);
		for (let i = 1; i < times.length; i++)
			expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
	});

	test("weekEnd off the hour is a single sample, dayEnd too", () => {
		// Monday 09:07:20, weekly reset beyond a week: weekEnd = now + 7 days, off every grid.
		const now = prague(16, 9, 7, 20);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [account({ id: "acct-a", weekReset: now + 8 * 24 * HOUR })],
			rate: () => 0,
		});
		expect(ctx.horizon.weekEnd).toBe(now + 7 * 24 * HOUR);
		const { times } = buildSampleAxis(ctx, onDemandPlan(ctx));
		expect(times.filter((t) => t === ctx.horizon.weekEnd)).toHaveLength(1);
		expect(times.filter((t) => t === ctx.horizon.dayEnd)).toHaveLength(1);
		expect(times[times.length - 1]).toBe(ctx.horizon.weekEnd);
	});

	test("weekEnd on an off-hour weekly reset appears twice", () => {
		const now = prague(12, 8);
		const reset = prague(14, 20, 17, 41);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [account({ id: "acct-a", weekReset: reset })],
			rate: () => 0,
		});
		expect(ctx.horizon.weekEnd).toBe(reset);
		const { times } = buildSampleAxis(ctx, onDemandPlan(ctx));
		expect(times.filter((t) => t === reset)).toHaveLength(2);
	});

	test("weekEnd inside the 5-minute part, off the grid, is a sample", () => {
		// The horizon rule never puts weekEnd inside fineEnd here, so it is placed by hand.
		const now = prague(12, 8);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [account({ id: "acct-a" })],
			rate: () => 0,
		});
		const weekEnd = now + 3 * HOUR + 2 * MIN + 13_000;
		ctx.horizon = { ...ctx.horizon, weekEnd };
		const { times } = buildSampleAxis(ctx, onDemandPlan(ctx));
		expect(times.filter((t) => t === weekEnd)).toHaveLength(1);
	});
});

describe("simulate", () => {
	test("fill time is interpolated to the minute, first partial step pro-rated", async () => {
		// 1 point a minute from now (k 10, 0.1 units a minute): 100 points after 100 minutes.
		const now = prague(12, 8, 0, 20);
		const ctx = makeCtx({
			now,
			days: 3,
			accounts: [
				account({ id: "acct-a", fiveUsed: 0, fiveReset: now + 4 * HOUR }),
			],
			k5: { "acct-a": 10 },
			rate: () => 0.1,
		});
		const result = await simulate(ctx, onDemandPlan(ctx));
		const [trace] = result.traces;
		expect(trace.outs[0]).toEqual({
			account: 0,
			at: prague(12, 9, 40),
			limit: "five_hour",
		});
		// The first partial step (08:00:20 to 08:05) carries 280 s of the bucket's demand.
		expect(trace.day[1]).toBeCloseTo(100 - (280 / 60) * 1, 3);
	});

	test("weekly used up counts 0 in the 5-hour pool until its weekly reset; resets jump", async () => {
		const now = prague(12, 8);
		const weekReset = now + 2 * HOUR;
		const fiveReset = now + 3 * HOUR;
		const ctx = makeCtx({
			now,
			days: 2,
			accounts: [
				account({ id: "acct-a", weekUsed: 100, weekReset }),
				account({
					id: "acct-b",
					fiveUsed: 40,
					fiveReset,
					weekUsed: 30,
					weekReset: now + 50 * HOUR,
				}),
			],
			rate: () => 0,
		});
		const { axis, traces } = await simulate(ctx, onDemandPlan(ctx));
		const [t] = traces;
		expect(t.day[0]).toBe(60);
		expect(t.week[0]).toBe(70);
		const w = indexAt(axis.times, weekReset);
		expect(axis.times[w + 1]).toBe(weekReset);
		expect([t.day[w], t.day[w + 1]]).toEqual([60, 160]);
		expect([t.week[w], t.week[w + 1]]).toEqual([70, 170]);
		const f = indexAt(axis.times, fiveReset);
		expect([t.day[f], t.day[f + 1]]).toEqual([160, 200]);
		// The weekly reset repeats seven days later; this horizon ends before it.
		expect(
			axis.times.filter((x) => x === weekReset + 7 * 24 * HOUR),
		).toHaveLength(0);
	});

	test("a blocked account is out until blockedUntil", async () => {
		const now = prague(12, 8);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [account({ id: "acct-a", blockedUntil: now + 30 * MIN })],
			k5: { "acct-a": 10 },
			rate: (_m, _w, at) => (at < now + HOUR ? 0.1 : 0),
		});
		const { axis, traces } = await simulate(ctx, onDemandPlan(ctx));
		const unservedUnits = traces[0].unserved.reduce((s, v) => s + v, 0);
		expect(unservedUnits).toBeCloseTo(3, 4);
		expect(traces[0].day[indexAt(axis.times, now + HOUR)]).toBeCloseTo(70, 3);
	});

	test("failover: the session moves to the account the policy picks and pays its move cost", async () => {
		const now = prague(12, 8);
		const s = session({
			sessionId: "s1",
			accountId: "acct-a",
			lastRequestAt: now,
			coldAt: now + HOUR,
			contextTokens: 1_000_000,
		});
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({ id: "acct-a", fiveUsed: 100, fiveReset: now + 3 * HOUR }),
				account({ id: "acct-b", fiveUsed: 0, fiveReset: now + 4 * HOUR }),
			],
			k5: { "acct-a": 10, "acct-b": 10 },
			rate: (_m, _w, at) => (at < now + 10 * MIN ? 0.1 : 0),
			sessions: [s],
			settings: { sessionTurnoverMin: 1e9 },
		});
		const { axis, traces } = await simulate(ctx, onDemandPlan(ctx));
		// Move cost 1.9 units × 10 = 19 points, plus 10 points of demand, all on acct-b.
		const i = indexAt(axis.times, now + 10 * MIN);
		expect(traces[0].day[i]).toBeCloseTo(0 + 100 - 19 - 10, 3);
		expect(traces[0].unserved.reduce((x, v) => x + v, 0)).toBe(0);
	});

	test("with every account out, demand is unserved", async () => {
		const now = prague(12, 8);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({ id: "acct-a", fiveUsed: 100, fiveReset: now + 3 * HOUR }),
				account({ id: "acct-b", fiveUsed: 100, fiveReset: now + 4 * HOUR }),
			],
			rate: (_m, _w, at) => (at < now + 10 * MIN ? 0.1 : 0),
		});
		const { traces } = await simulate(ctx, onDemandPlan(ctx));
		expect(traces[0].unserved.reduce((x, v) => x + v, 0)).toBeCloseTo(1, 5);
	});

	test("unattached demand goes to the window that resets first", async () => {
		const now = prague(12, 8);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({ id: "acct-a", fiveUsed: 0, fiveReset: now + 4 * HOUR }),
				account({ id: "acct-b", fiveUsed: 50, fiveReset: now + HOUR }),
			],
			k5: { "acct-a": 10, "acct-b": 10 },
			rate: () => 0.1,
		});
		const { traces } = await simulate(ctx, onDemandPlan(ctx));
		expect(traces[0].outs[0]).toEqual({
			account: 1,
			at: now + 50 * MIN,
			limit: "five_hour",
		});
	});

	describe("planned opening: pre-warm on vs off", () => {
		const now = prague(12, 6);
		const openAt = now + HOUR;
		const build = (prewarm: boolean) =>
			makeCtx({
				now,
				days: 1,
				accounts: [account({ id: "acct-a" }), account({ id: "acct-b" })],
				k5: { "acct-a": 10, "acct-b": 10 },
				// Demand from 08:00: 1 point a minute.
				rate: (_m, _w, at) =>
					at >= now + 2 * HOUR && at < now + 4 * HOUR ? 0.1 : 0,
				settings: { prewarm },
			});
		const plan: SimPlan = {
			openAt: [null, openAt],
			preferred: null,
			move: null,
		};

		test("on: the window opens at the planned time without demand", async () => {
			const ctx = build(true);
			const { axis, traces } = await simulate(ctx, plan);
			const [t] = traces;
			const r = indexAt(axis.times, openAt + 5 * HOUR);
			expect(axis.times[r + 1]).toBe(openAt + 5 * HOUR);
			// acct-b took the demand from 08:00 (opening has come), filled at 09:40, reset at 12:00.
			expect(t.outs[0]).toEqual({
				account: 1,
				at: now + 3 * HOUR + 40 * MIN,
				limit: "five_hour",
			});
			expect(t.day[r]).toBeCloseTo(100 + 0 - 20, 3);
			expect(t.day[r + 1]).toBeCloseTo(200 - 20, 3);
		});

		test("off: the planned opening only routes; the window opens at the first demand", async () => {
			const ctx = build(false);
			const { axis, traces } = await simulate(ctx, plan);
			const [t] = traces;
			// The planned reset is a jump pair; demand came only at 08:00, so both values are equal.
			const r = indexAt(axis.times, openAt + 5 * HOUR);
			expect(axis.times[r + 1]).toBe(openAt + 5 * HOUR);
			expect(t.day[r]).toBe(t.day[r + 1]);
			expect(t.outs[0]).toEqual({
				account: 1,
				at: now + 3 * HOUR + 40 * MIN,
				limit: "five_hour",
			});
			// acct-b opened at 08:00, so it is still full at 12:00 and resets at 13:00.
			expect(t.day[indexAt(axis.times, now + 6 * HOUR)]).toBeCloseTo(80, 3);
			expect(t.day[indexAt(axis.times, now + 7 * HOUR + 5 * MIN)]).toBeCloseTo(
				180,
				3,
			);
		});
	});

	describe("pre-warm off: a planned routing-opening while another window is open (design 4.5)", () => {
		// acct-a open until 11:00, acct-b closed and planned for 08:00; 1 point a minute from 07:00.
		const now = prague(12, 7);
		const plannedAt = prague(12, 8);
		const build = () =>
			makeCtx({
				now,
				days: 1,
				accounts: [
					account({ id: "acct-a", fiveReset: prague(12, 11) }),
					account({ id: "acct-b" }),
				],
				k5: { "acct-a": 10, "acct-b": 10 },
				rate: (_m, _w, at) => (at < prague(12, 11) ? 0.1 : 0),
				settings: { prewarm: false },
			});

		test("the first unattached demand at the planned time opens acct-b; then the base order sends demand back to acct-a", async () => {
			const { traces } = await simulate(build(), {
				openAt: [null, plannedAt],
				preferred: null,
				move: null,
			});
			const [t] = traces;
			expect(t.opens).toEqual([{ account: 1, at: plannedAt }]);
			// acct-a (earliest reset first) keeps the demand and fills at 08:40; acct-b takes it from there.
			expect(t.outs).toEqual([
				{ account: 0, at: prague(12, 8, 40), limit: "five_hour" },
				{ account: 1, at: prague(12, 10, 20), limit: "five_hour" },
			]);
		});

		test("on demand acct-b opens only when acct-a is full", async () => {
			const { traces } = await simulate(build(), onDemandPlan(build()));
			expect(traces[0].opens).toEqual([{ account: 1, at: prague(12, 8, 40) }]);
		});

		test("a preference for the open account does not hold back the due opening", async () => {
			const { traces } = await simulate(build(), {
				openAt: [null, plannedAt],
				preferred: 0,
				move: null,
			});
			expect(traces[0].opens).toEqual([{ account: 1, at: plannedAt }]);
			expect(traces[0].outs[0]).toEqual({
				account: 0,
				at: prague(12, 8, 40),
				limit: "five_hour",
			});
		});

		test("two openings due at once both open through the first demand; the demand stays on acct-a", async () => {
			const ctx = makeCtx({
				now,
				days: 1,
				accounts: [
					account({ id: "acct-a", fiveReset: prague(12, 11) }),
					account({ id: "acct-b" }),
					account({ id: "acct-c" }),
				],
				k5: { "acct-a": 10, "acct-b": 10, "acct-c": 10 },
				rate: (_m, _w, at) => (at < prague(12, 11) ? 0.1 : 0),
				settings: { prewarm: false },
			});
			const { traces } = await simulate(ctx, {
				openAt: [null, plannedAt, plannedAt],
				preferred: null,
				move: null,
			});
			expect(traces[0].opens).toEqual([
				{ account: 1, at: plannedAt },
				{ account: 2, at: plannedAt },
			]);
			expect(traces[0].outs[0]).toEqual({
				account: 0,
				at: prague(12, 8, 40),
				limit: "five_hour",
			});
		});

		test("a preference for the planned account is its own plan: after the opening it keeps the demand", async () => {
			const { traces } = await simulate(build(), {
				openAt: [null, plannedAt],
				preferred: 1,
				move: null,
			});
			expect(traces[0].opens).toEqual([{ account: 1, at: plannedAt }]);
			expect(traces[0].outs[0]).toEqual({
				account: 1,
				at: prague(12, 9, 40),
				limit: "five_hour",
			});
		});

		test("without demand at the planned time the window waits for the first demand after it", async () => {
			const ctx = makeCtx({
				now,
				days: 1,
				accounts: [
					account({ id: "acct-a", fiveReset: prague(12, 11) }),
					account({ id: "acct-b" }),
				],
				k5: { "acct-a": 10, "acct-b": 10 },
				rate: (_m, _w, at) =>
					at >= prague(12, 9) && at < prague(12, 10) ? 0.1 : 0,
				settings: { prewarm: false },
			});
			const { traces } = await simulate(ctx, {
				openAt: [null, plannedAt],
				preferred: null,
				move: null,
			});
			expect(traces[0].opens).toEqual([{ account: 1, at: prague(12, 9) }]);
		});
	});

	test("pre-warm on: the opening at the planned time is recorded", async () => {
		const now = prague(12, 7);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({ id: "acct-a", fiveReset: prague(12, 11) }),
				account({ id: "acct-b" }),
			],
			rate: () => 0,
			settings: { prewarm: true },
		});
		const { traces } = await simulate(ctx, {
			openAt: [null, prague(12, 8)],
			preferred: null,
			move: null,
		});
		expect(traces[0].opens).toEqual([{ account: 1, at: prague(12, 8) }]);
	});

	test("last resort: a closed account with no planned opening goes before one planned for later", async () => {
		const now = prague(12, 6);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [account({ id: "acct-a" }), account({ id: "acct-b" })],
			k5: { "acct-a": 10, "acct-b": 10 },
			rate: (_m, _w, at) => (at < now + 2 * HOUR ? 0.1 : 0),
		});
		const { traces } = await simulate(ctx, {
			openAt: [now + 3 * HOUR, null],
			preferred: null,
			move: null,
		});
		expect(traces[0].outs[0]).toEqual({
			account: 1,
			at: now + 100 * MIN,
			limit: "five_hour",
		});
	});

	describe("demand before a planned opening never reaches the scheduled account", () => {
		const now = prague(12, 8);
		const build = () =>
			makeCtx({
				now,
				days: 1,
				accounts: [account({ id: "acct-a" }), account({ id: "acct-b" })],
				k5: { "acct-a": 10, "acct-b": 10 },
				kW: { "acct-a": 1, "acct-b": 2 },
				// 0.1 units from 08:00 to 08:10, before acct-a's 09:00 opening.
				rate: (_m, _w, at) => (at < now + 10 * MIN ? 0.1 : 0),
			});
		for (const preferred of [null, 0, 1]) {
			test(`preferred ${preferred}`, async () => {
				const ctx = build();
				const { axis, traces } = await simulate(ctx, {
					openAt: [now + HOUR, null],
					preferred,
					move: null,
				});
				// 1 unit served: acct-b's weekly k is 2, acct-a's would be 1.
				const i = indexAt(axis.times, now + 10 * MIN);
				expect(traces[0].week[i]).toBeCloseTo(198, 4);
			});
		}
	});

	test("Fable out time is recorded per account", async () => {
		const now = prague(12, 8);
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({ id: "acct-a", fiveReset: now + 4 * HOUR, fableUsed: 90 }),
			],
			k5: { "acct-a": 1 },
			kF: { "acct-a": 10 },
			fableShare: 0.5,
			rate: () => 0.1,
		});
		const { traces } = await simulate(ctx, onDemandPlan(ctx));
		// 0.05 Fable units a minute × 10 = 0.5 points a minute: 10 points after 20 minutes.
		expect(traces[0].fableOutAt).toEqual([now + 20 * MIN]);
	});

	test("determinism: same input, same traces", async () => {
		const now = prague(12, 8);
		const make = () =>
			makeCtx({
				now,
				days: 30,
				spread: 0.3,
				accounts: [
					account({ id: "acct-a" }),
					account({ id: "acct-b", fiveUsed: 20, fiveReset: now + HOUR }),
				],
				rate: (m) => (m > 600 && m < 1000 ? 0.6 : 0),
			});
		const a = await simulate(make(), onDemandPlan(make()));
		const b = await simulate(make(), onDemandPlan(make()));
		expect(b).toEqual(a);
	});

	test("yields between blocks of simulated days (400 days, week horizon)", async () => {
		const now = prague(9, 8); // Monday: horizon to Friday 24:00
		const ctx = makeCtx({
			now,
			days: 400,
			spread: 0.3,
			accounts: [account({ id: "acct-a" }), account({ id: "acct-b" })],
			rate: (m, w) => (w <= 5 && m > 540 && m < 1080 ? 0.7 : 0),
		});
		const { value, longestMs, turns, wallMs } = await measureYield(() =>
			simulate(ctx, onDemandPlan(ctx)),
		);
		console.log(
			`simulate 400 days, ${value.axis.times.length} samples: wall ${wallMs.toFixed(0)} ms, longest slice ${longestMs.toFixed(1)} ms, ${turns} turns`,
		);
		expect(value.traces).toHaveLength(400);
		expect(turns).toBeGreaterThanOrEqual(19);
		expect(longestMs).toBeLessThan(50);
	});
});
