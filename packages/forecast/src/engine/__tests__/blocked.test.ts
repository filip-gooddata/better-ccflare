import { describe, expect, test } from "bun:test";
import { pooledLeftNow } from "../past";
import { buildSampleAxis, onDemandPlan, simulate } from "../simulate";
import { account, HOUR, indexAt, makeCtx, prague } from "./fixtures-sim";

describe("a refusal cooldown counts 0 in the 5-hour pool until it ends (spec section 3)", () => {
	const now = prague(12, 8);

	test("a blocked account with quota left in its open window counts 0", async () => {
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({
					id: "acct-a",
					fiveUsed: 30,
					fiveReset: now + 4 * HOUR,
					blockedUntil: now + 40 * HOUR,
				}),
				account({ id: "acct-b", fiveUsed: 40, fiveReset: now + 3 * HOUR }),
			],
			rate: () => 0,
		});
		const { traces } = await simulate(ctx, onDemandPlan(ctx));
		expect(traces[0].day[0]).toBe(60);
		expect(traces[0].week[0]).toBe(200);
		expect(pooledLeftNow(ctx.accounts, "day", now)).toBe(60);
		expect(pooledLeftNow(ctx.accounts, "week", now)).toBe(200);
	});

	test("its 5-hour window resetting while it is blocked leaves it at 0", async () => {
		const fiveReset = now + 2 * HOUR;
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({
					id: "acct-a",
					fiveUsed: 79,
					fiveReset,
					blockedUntil: now + 40 * HOUR,
				}),
				account({ id: "acct-b", fiveUsed: 21, fiveReset: now + 9 * HOUR }),
			],
			rate: () => 0,
		});
		const { axis, traces } = await simulate(ctx, onDemandPlan(ctx));
		const [t] = traces;
		const f = indexAt(axis.times, fiveReset);
		expect(axis.times[f + 1]).toBe(fiveReset);
		expect([t.day[f], t.day[f + 1]]).toEqual([79, 79]);
	});

	test("a cooldown ending inside the horizon counts again from that instant, a jump on the axis", async () => {
		const blockedUntil = now + 5 * HOUR + 17 * 60_000 + 3_456;
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({
					id: "acct-a",
					fiveUsed: 30,
					fiveReset: now + 2 * HOUR,
					blockedUntil,
				}),
				account({ id: "acct-b", fiveUsed: 40, fiveReset: now + 3 * HOUR }),
			],
			rate: () => 0,
		});
		const axis = buildSampleAxis(ctx, onDemandPlan(ctx));
		expect(axis.times.filter((x) => x === blockedUntil)).toHaveLength(2);
		const sim = await simulate(ctx, onDemandPlan(ctx));
		const [t] = sim.traces;
		const b = indexAt(sim.axis.times, blockedUntil);
		expect(sim.axis.times[b + 1]).toBe(blockedUntil);
		expect([t.day[b - 1], t.day[b], t.day[b + 1]]).toEqual([100, 100, 200]);
		expect(t.day.at(-1)).toBe(200);
	});

	test("a cooldown ending on a grid point is still a jump pair", async () => {
		const blockedUntil = now + 2 * HOUR;
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({ id: "acct-a", fiveUsed: 10, blockedUntil }),
				account({ id: "acct-b", fiveUsed: 0 }),
			],
			rate: () => 0,
		});
		const sim = await simulate(ctx, onDemandPlan(ctx));
		const [t] = sim.traces;
		expect(sim.axis.times.filter((x) => x === blockedUntil)).toHaveLength(2);
		const b = indexAt(sim.axis.times, blockedUntil);
		expect([t.day[0], t.day[b], t.day[b + 1]]).toEqual([100, 100, 200]);
	});

	test("both reasons at once: it counts again only when the later one ends", async () => {
		const weekReset = now + 2 * HOUR;
		const blockedUntil = now + 4 * HOUR;
		const ctx = makeCtx({
			now,
			days: 1,
			accounts: [
				account({
					id: "acct-a",
					weekUsed: 100,
					weekReset,
					blockedUntil,
				}),
				account({
					id: "acct-b",
					weekUsed: 100,
					weekReset: now + 6 * HOUR,
					blockedUntil: now + 3 * HOUR,
				}),
			],
			rate: () => 0,
		});
		const { axis, traces } = await simulate(ctx, onDemandPlan(ctx));
		const [t] = traces;
		expect(t.day[0]).toBe(0);
		const w = indexAt(axis.times, weekReset);
		expect([t.day[w], t.day[w + 1]]).toEqual([0, 0]);
		const bB = indexAt(axis.times, now + 3 * HOUR);
		expect([t.day[bB], t.day[bB + 1]]).toEqual([0, 0]);
		const bA = indexAt(axis.times, blockedUntil);
		expect([t.day[bA], t.day[bA + 1]]).toEqual([0, 100]);
		const wB = indexAt(axis.times, now + 6 * HOUR);
		expect([t.day[wB], t.day[wB + 1]]).toEqual([100, 200]);
		expect(pooledLeftNow(ctx.accounts, "day", now)).toBe(0);
	});

	test("a cooldown already over by now changes nothing", async () => {
		const accounts = [
			account({
				id: "acct-a",
				fiveUsed: 30,
				fiveReset: now + 2 * HOUR,
				blockedUntil: now,
			}),
			account({ id: "acct-b", fiveUsed: 40, fiveReset: now + 3 * HOUR }),
		];
		const ctx = makeCtx({ now, days: 1, accounts, rate: () => 0 });
		const { traces } = await simulate(ctx, onDemandPlan(ctx));
		expect(traces[0].day[0]).toBe(130);
		expect(pooledLeftNow(ctx.accounts, "day", now)).toBe(130);
		const plain = buildSampleAxis(
			makeCtx({
				now,
				days: 1,
				accounts: accounts.map((a) => ({ ...a, blockedUntil: null })),
				rate: () => 0,
			}),
			onDemandPlan(ctx),
		);
		expect(buildSampleAxis(ctx, onDemandPlan(ctx)).times).toEqual(plain.times);
	});
});
