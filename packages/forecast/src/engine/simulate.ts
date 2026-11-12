/**
 * Simulated depletion with refill jumps (design 4.5): every simulated day of the scenarios is run
 * through the accounts' 5-hour, weekly and Fable limits under one plan, and sampled on a shared
 * time axis.
 */
import type { EpochMs, LiveSession } from "../types";
import { BUCKET_MS, FIVE_HOUR_MS, WEEK_MS } from "../types";
import type {
	EngineContext,
	OutLimit,
	SampleAxis,
	SimTrace,
	SimulationResult,
} from "./model";
import { moveCostUnits } from "./move-cost";
import { yieldToEventLoop } from "./yield";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Fine steps: 5 minutes on the clock for the first 24 hours (design 4.5). */
const FINE_STEP_MS = 5 * MINUTE_MS;
/** Coarse steps: whole hours from the end of the fine part to the end of the simulation. */
const COARSE_STEP_MS = HOUR_MS;
/** Simulated days run between two yields: about 5 ms per slice at a week horizon on this machine. */
const DAYS_PER_SLICE = 20;
/** Use at or above 100 points is full; the tiny slack absorbs float rounding of k·u sums. */
const FULL_POINTS = 100 - 1e-9;

/** One candidate plan as the simulation applies it. Account index = position in EngineContext.accounts. */
export interface SimPlan {
	/** Planned opening time per account index; null = open on demand. Only used for accounts closed now. */
	openAt: (EpochMs | null)[];
	/** Account preferred for unattached demand now (new and cold sessions), or null for the base order. */
	preferred: number | null;
	/** At most one move of one warm live session to another account, made now. */
	move: { sessionId: string; to: number } | null;
}

export function onDemandPlan(ctx: EngineContext): SimPlan {
	return {
		openAt: ctx.accounts.map(() => null),
		preferred: null,
		move: null,
	};
}

export function isOpenNow(ctx: EngineContext, index: number): boolean {
	const resetsAt = ctx.accounts[index].fiveHour.resetsAt;
	return resetsAt !== null && resetsAt > ctx.now;
}

/** When a live session's cache goes cold; an unknown lifetime falls back to the pace idle time. */
export function sessionColdAt(
	ctx: EngineContext,
	session: LiveSession,
): EpochMs {
	return session.coldAt ?? session.lastRequestAt + ctx.input.pace.idleMs;
}

/** Live sessions whose cache is still warm now (cold sessions carry no attachment and never move). */
export function warmSessions(ctx: EngineContext): LiveSession[] {
	return ctx.input.sessions.filter(
		(session) => sessionColdAt(ctx, session) > ctx.now,
	);
}

/** Deterministic jump times in (now, simEnd]: resets of windows open now, weekly resets, pre-warm resets. */
function jumpTimes(ctx: EngineContext, plan: SimPlan): EpochMs[] {
	const { now } = ctx;
	const end = ctx.horizon.simEnd;
	const jumps = new Set<EpochMs>();
	const add = (at: EpochMs) => {
		if (at > now && at <= end) jumps.add(at);
	};
	ctx.accounts.forEach((account, index) => {
		if (isOpenNow(ctx, index) && account.fiveHour.resetsAt !== null)
			add(account.fiveHour.resetsAt);
		if (account.weekly.resetsAt !== null) {
			let at = account.weekly.resetsAt;
			while (at <= now) at += WEEK_MS;
			for (; at <= end; at += WEEK_MS) add(at);
		}
		const openAt = plan.openAt[index];
		if (ctx.input.settings.prewarm && openAt != null && !isOpenNow(ctx, index))
			add(Math.max(openAt, now) + FIVE_HOUR_MS);
	});
	return [...jumps].sort((a, b) => a - b);
}

/**
 * Shared axis: now; every 5 minutes on the clock to fineEnd; every full hour to simEnd (both ends
 * included); every deterministic jump twice (value before, value after).
 */
export function buildSampleAxis(ctx: EngineContext, plan: SimPlan): SampleAxis {
	const { now } = ctx;
	const { fineEnd, simEnd } = ctx.horizon;
	const grid: EpochMs[] = [now];
	for (
		let at = Math.floor(now / FINE_STEP_MS) * FINE_STEP_MS + FINE_STEP_MS;
		at < fineEnd;
		at += FINE_STEP_MS
	)
		grid.push(at);
	if (fineEnd > now) grid.push(fineEnd);
	for (
		let at =
			Math.floor(fineEnd / COARSE_STEP_MS) * COARSE_STEP_MS + COARSE_STEP_MS;
		at < simEnd;
		at += COARSE_STEP_MS
	)
		grid.push(at);
	if (simEnd > fineEnd) grid.push(simEnd);
	const onGrid = new Set(grid);
	const times = [...grid];
	for (const jump of jumpTimes(ctx, plan)) {
		times.push(jump);
		if (!onGrid.has(jump)) times.push(jump);
	}
	times.sort((a, b) => a - b);
	return { times };
}

interface IntervalDemand {
	/** Per axis index i: buckets overlapping (times[i-1], times[i]] in bucketIndex/bucketFrac[from[i]..from[i+1]). */
	from: Int32Array;
	bucketIndex: Int32Array;
	bucketFrac: Float64Array;
	/** Attached share e^(-h/T) at the middle of each interval. */
	attached: Float64Array;
}

function intervalDemand(ctx: EngineContext, times: EpochMs[]): IntervalDemand {
	const { start, bucketCount } = ctx.scenarios;
	const turnoverMs = ctx.input.settings.sessionTurnoverMin * MINUTE_MS;
	const from = new Int32Array(times.length + 1);
	const index: number[] = [];
	const frac: number[] = [];
	const attached = new Float64Array(times.length);
	for (let i = 1; i < times.length; i++) {
		from[i] = index.length;
		const a = times[i - 1];
		const b = times[i];
		if (b <= a) continue;
		const mid = (a + b) / 2 - ctx.now;
		attached[i] = turnoverMs > 0 ? Math.exp(-mid / turnoverMs) : 0;
		const first = Math.max(0, Math.floor((a - start) / BUCKET_MS));
		const last = Math.min(
			bucketCount - 1,
			Math.floor((b - 1 - start) / BUCKET_MS),
		);
		for (let k = first; k <= last; k++) {
			const bucketA = start + k * BUCKET_MS;
			const overlap = Math.min(b, bucketA + BUCKET_MS) - Math.max(a, bucketA);
			if (overlap > 0) {
				index.push(k);
				frac.push(overlap / BUCKET_MS);
			}
		}
	}
	from[times.length] = index.length;
	from[0] = 0;
	return {
		from,
		bucketIndex: Int32Array.from(index),
		bucketFrac: Float64Array.from(frac),
		attached,
	};
}

interface Prepared {
	ctx: EngineContext;
	plan: SimPlan;
	times: EpochMs[];
	demand: IntervalDemand;
	n: number;
	k5: Float64Array;
	kW: Float64Array;
	/** NaN = no Fable tracking for that account. */
	kF: Float64Array;
	prewarm: boolean;
	/** Warm sessions carrying attachment. */
	sessionShare: Float64Array;
	sessionHome: Int32Array;
	sessionCost: Float64Array;
	moveSession: number;
	moveTo: number;
}

function prepare(ctx: EngineContext, plan: SimPlan): Prepared {
	const n = ctx.accounts.length;
	const k5 = new Float64Array(n);
	const kW = new Float64Array(n);
	const kF = new Float64Array(n);
	ctx.accounts.forEach((account, j) => {
		const id = account.accountId;
		k5[j] = ctx.calibration.fiveHour[id] ?? 0;
		kW[j] = ctx.calibration.weekly[id] ?? 0;
		const fable = ctx.calibration.fable[id];
		kF[j] = account.fable && fable != null ? fable : Number.NaN;
	});
	const warm = warmSessions(ctx).filter((session) => session.recentUnits > 0);
	const total = warm.reduce((sum, session) => sum + session.recentUnits, 0);
	const indexOf = new Map(ctx.accounts.map((a, j) => [a.accountId, j]));
	const times = buildSampleAxis(ctx, plan).times;
	let moveSession = -1;
	let moveTo = -1;
	if (plan.move && plan.move.to >= 0 && plan.move.to < n) {
		moveSession = warm.findIndex((s) => s.sessionId === plan.move?.sessionId);
		if (moveSession >= 0) moveTo = plan.move.to;
	}
	return {
		ctx,
		plan,
		times,
		demand: intervalDemand(ctx, times),
		n,
		k5,
		kW,
		kF,
		prewarm: ctx.input.settings.prewarm,
		sessionShare: Float64Array.from(warm, (s) => s.recentUnits / total),
		sessionHome: Int32Array.from(warm, (s) => indexOf.get(s.accountId) ?? -1),
		sessionCost: Float64Array.from(warm, moveCostUnits),
		moveSession,
		moveTo,
	};
}

/** Mutable state of one simulated day. */
class DayRun {
	readonly n: number;
	readonly used5: Float64Array;
	/** NaN = 5-hour window closed. */
	readonly reset5: Float64Array;
	readonly usedW: Float64Array;
	readonly resetW: Float64Array;
	readonly usedF: Float64Array;
	readonly resetF: Float64Array;
	readonly blocked: Float64Array;
	readonly openAt: Float64Array;
	readonly openPending: Uint8Array;
	readonly sessionAt: Int32Array;
	readonly rates: Float64Array;
	/** Per account: when it fills at the current rates, and whether the weekly limit is the one that fills. */
	readonly fillAt: Float64Array;
	readonly fillWeekly: Uint8Array;
	prefActive = false;
	unserved = 0;
	outs: SimTrace["outs"] = [];
	fableOutAt: (EpochMs | null)[] = [];

	constructor(readonly p: Prepared) {
		this.n = p.n;
		const n = p.n;
		this.used5 = new Float64Array(n);
		this.reset5 = new Float64Array(n);
		this.usedW = new Float64Array(n);
		this.resetW = new Float64Array(n);
		this.usedF = new Float64Array(n);
		this.resetF = new Float64Array(n);
		this.blocked = new Float64Array(n);
		this.openAt = new Float64Array(n);
		this.openPending = new Uint8Array(n);
		this.sessionAt = new Int32Array(p.sessionHome.length);
		this.rates = new Float64Array(n);
		this.fillAt = new Float64Array(n);
		this.fillWeekly = new Uint8Array(n);
	}

	reset(): void {
		const { ctx, plan } = this.p;
		const now = ctx.now;
		this.outs = [];
		this.fableOutAt = [];
		this.unserved = 0;
		this.prefActive = plan.preferred !== null;
		ctx.accounts.forEach((account, j) => {
			const five = account.fiveHour;
			if (five.resetsAt !== null && five.resetsAt > now) {
				this.used5[j] = clampPoints(five.usedPct);
				this.reset5[j] = five.resetsAt;
			} else {
				this.used5[j] = 0;
				this.reset5[j] = Number.NaN;
			}
			[this.usedW[j], this.resetW[j]] = startWeekly(
				account.weekly.usedPct,
				account.weekly.resetsAt,
				now,
			);
			if (account.fable && !Number.isNaN(this.p.kF[j])) {
				[this.usedF[j], this.resetF[j]] = startWeekly(
					account.fable.usedPct,
					account.fable.resetsAt,
					now,
				);
				this.fableOutAt.push(this.usedF[j] >= FULL_POINTS ? now : null);
			} else {
				this.usedF[j] = 0;
				this.resetF[j] = Number.POSITIVE_INFINITY;
				this.fableOutAt.push(null);
			}
			this.blocked[j] = account.blockedUntil ?? Number.NEGATIVE_INFINITY;
			const planned = plan.openAt[j];
			const pending = planned != null && Number.isNaN(this.reset5[j]);
			this.openPending[j] = pending ? 1 : 0;
			this.openAt[j] = pending ? Math.max(planned, now) : Number.NaN;
		});
		this.sessionAt.set(this.p.sessionHome);
	}

	isOpen(j: number): boolean {
		return !Number.isNaN(this.reset5[j]);
	}

	usable(j: number, t: EpochMs): boolean {
		if (j < 0 || this.blocked[j] > t) return false;
		if (this.usedW[j] >= FULL_POINTS) return false;
		return !(this.isOpen(j) && this.used5[j] >= FULL_POINTS);
	}

	/** Account for unattached demand at t: preference, then base order (design 4.5); -1 when none. */
	pick(t: EpochMs): number {
		const preferred = this.p.plan.preferred;
		if (this.prefActive && preferred !== null && this.usable(preferred, t))
			return preferred;
		let best = -1;
		for (let j = 0; j < this.n; j++)
			if (this.isOpen(j) && this.usable(j, t))
				if (best < 0 || this.reset5[j] < this.reset5[best]) best = j;
		if (best >= 0) return best;
		for (let j = 0; j < this.n; j++)
			if (this.openPending[j] && this.openAt[j] <= t && this.usable(j, t))
				if (best < 0 || this.openAt[j] < this.openAt[best]) best = j;
		if (best >= 0) return best;
		for (let j = 0; j < this.n; j++) if (this.usable(j, t)) return j;
		return -1;
	}

	open(j: number, t: EpochMs): void {
		this.reset5[j] = t + FIVE_HOUR_MS;
		this.used5[j] = 0;
		if (this.openPending[j] && this.openAt[j] <= t) this.openPending[j] = 0;
	}

	/** Records an account running out at t, once per filling. */
	markOut(j: number, t: EpochMs, limit: OutLimit): void {
		this.outs.push({ account: j, at: roundToMinute(t), limit });
		if (this.p.plan.preferred === j) this.prefActive = false;
	}

	/** Adds k·u to the account's limits; returns true when it fills (at t). */
	charge(j: number, units: number, t: EpochMs): boolean {
		if (!this.isOpen(j)) this.open(j, t);
		const fullBefore5 = this.used5[j] >= FULL_POINTS;
		const fullBeforeW = this.usedW[j] >= FULL_POINTS;
		this.used5[j] = Math.min(100, this.used5[j] + this.p.k5[j] * units);
		this.usedW[j] = Math.min(100, this.usedW[j] + this.p.kW[j] * units);
		if (!fullBeforeW && this.usedW[j] >= FULL_POINTS) {
			this.markOut(j, t, "seven_day");
			return true;
		}
		if (!fullBefore5 && this.used5[j] >= FULL_POINTS) {
			this.markOut(j, t, "five_hour");
			return true;
		}
		return false;
	}

	/** Applies every event due at or before t: 5-hour, weekly and Fable resets, pre-warm openings. */
	applyDue(t: EpochMs): void {
		const preferred = this.p.plan.preferred;
		for (let j = 0; j < this.n; j++) {
			if (this.isOpen(j) && this.reset5[j] <= t) {
				this.reset5[j] = Number.NaN;
				this.used5[j] = 0;
				if (preferred === j) this.prefActive = false;
			}
			while (this.resetW[j] <= t) {
				this.usedW[j] = 0;
				this.resetW[j] += WEEK_MS;
			}
			while (this.resetF[j] <= t) {
				this.usedF[j] = 0;
				this.resetF[j] += WEEK_MS;
			}
			if (this.p.prewarm && this.openPending[j] && this.openAt[j] <= t) {
				this.openPending[j] = 0;
				if (!this.isOpen(j) && this.usable(j, this.openAt[j])) {
					this.reset5[j] = this.openAt[j] + FIVE_HOUR_MS;
					this.used5[j] = 0;
				}
			}
		}
	}

	/** First event strictly after t that changes limits or routing. */
	nextEvent(t: EpochMs): EpochMs {
		let next = Number.POSITIVE_INFINITY;
		for (let j = 0; j < this.n; j++) {
			if (this.isOpen(j) && this.reset5[j] > t && this.reset5[j] < next)
				next = this.reset5[j];
			if (this.resetW[j] > t && this.resetW[j] < next) next = this.resetW[j];
			if (this.resetF[j] > t && this.resetF[j] < next) next = this.resetF[j];
			if (this.blocked[j] > t && this.blocked[j] < next) next = this.blocked[j];
			if (this.openPending[j] && this.openAt[j] > t && this.openAt[j] < next)
				next = this.openAt[j];
		}
		return next;
	}

	/** Move of a session: the target pays its move cost; returns false when no account can take it. */
	failover(q: number, t: EpochMs): boolean {
		for (let attempt = 0; attempt <= this.n; attempt++) {
			const target = this.pick(t);
			if (target < 0) return false;
			this.sessionAt[q] = target;
			if (!this.charge(target, this.p.sessionCost[q], t)) return true;
		}
		return false;
	}

	/**
	 * Serves demand at constant rate over [a, b): demand units per ms in total, with a Fable ratio.
	 * Phases end when an account fills, so the fill time is exact up to the minute rounding.
	 */
	serve(
		a: EpochMs,
		b: EpochMs,
		rate: number,
		fableRatio: number,
		phi: number,
	): void {
		const p = this.p;
		const rates = this.rates;
		let t = a;
		for (let guard = 0; t < b && guard < 4 * this.n + 8; guard++) {
			rates.fill(0);
			let lost = 0;
			for (let q = 0; q < p.sessionShare.length; q++) {
				const r = rate * phi * p.sessionShare[q];
				if (r <= 0) continue;
				if (!this.usable(this.sessionAt[q], t) && !this.failover(q, t)) {
					lost += r;
					continue;
				}
				rates[this.sessionAt[q]] += r;
			}
			const free = rate * (1 - (p.sessionShare.length > 0 ? phi : 0));
			if (free > 0) {
				const target = this.pick(t);
				if (target < 0) lost += free;
				else rates[target] += free;
			}
			let end = b;
			const fillAt = this.fillAt;
			for (let j = 0; j < this.n; j++) {
				fillAt[j] = Number.POSITIVE_INFINITY;
				if (rates[j] <= 0) continue;
				if (!this.isOpen(j)) this.open(j, t);
				const cap5 =
					p.k5[j] > 0
						? (100 - this.used5[j]) / p.k5[j]
						: Number.POSITIVE_INFINITY;
				const capW =
					p.kW[j] > 0
						? (100 - this.usedW[j]) / p.kW[j]
						: Number.POSITIVE_INFINITY;
				this.fillWeekly[j] = capW < cap5 ? 1 : 0;
				fillAt[j] = t + Math.min(cap5, capW) / rates[j];
				if (fillAt[j] < end) end = fillAt[j];
			}
			const dt = end - t;
			this.unserved += lost * dt;
			for (let j = 0; j < this.n; j++) {
				if (rates[j] <= 0) continue;
				const units = rates[j] * dt;
				this.used5[j] = Math.min(100, this.used5[j] + p.k5[j] * units);
				this.usedW[j] = Math.min(100, this.usedW[j] + p.kW[j] * units);
				// Every account whose fill time is reached (a step boundary included) is out now.
				if (fillAt[j] <= end) {
					const limit: OutLimit = this.fillWeekly[j]
						? "seven_day"
						: "five_hour";
					if (limit === "seven_day") this.usedW[j] = 100;
					else this.used5[j] = 100;
					this.markOut(j, fillAt[j], limit);
				}
				const kF = p.kF[j];
				if (
					!Number.isNaN(kF) &&
					fableRatio > 0 &&
					this.usedF[j] < FULL_POINTS
				) {
					const add = kF * units * fableRatio;
					if (this.usedF[j] + add >= FULL_POINTS && this.fableOutAt[j] === null)
						this.fableOutAt[j] = roundToMinute(
							t + (dt * (100 - this.usedF[j])) / add,
						);
					this.usedF[j] = Math.min(100, this.usedF[j] + add);
				}
			}
			t = end;
		}
	}

	day(): number {
		let sum = 0;
		for (let j = 0; j < this.n; j++) {
			if (this.usedW[j] >= FULL_POINTS) continue;
			sum += this.isOpen(j) ? 100 - this.used5[j] : 100;
		}
		return sum;
	}

	week(): number {
		let sum = 0;
		for (let j = 0; j < this.n; j++) sum += 100 - this.usedW[j];
		return sum;
	}
}

function clampPoints(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/** Weekly-type limit at now: use and next reset; a passed reset means use 0 and the next weekly reset. */
function startWeekly(
	usedPct: number,
	resetsAt: EpochMs | null,
	now: EpochMs,
): [number, number] {
	if (resetsAt === null)
		return [clampPoints(usedPct), Number.POSITIVE_INFINITY];
	if (resetsAt > now) return [clampPoints(usedPct), resetsAt];
	let next = resetsAt;
	while (next <= now) next += WEEK_MS;
	return [0, next];
}

function roundToMinute(at: EpochMs): EpochMs {
	return Math.round(at / MINUTE_MS) * MINUTE_MS;
}

function runDay(
	run: DayRun,
	units: Float32Array,
	fable: Float32Array,
): SimTrace {
	const p = run.p;
	const { times, demand } = p;
	const len = times.length;
	const trace: SimTrace = {
		day: new Float32Array(len),
		week: new Float32Array(len),
		unserved: new Float32Array(len),
		outs: [],
		fableOutAt: [],
	};
	run.reset();
	const now = times[0];
	run.applyDue(now);
	if (p.moveSession >= 0) {
		run.sessionAt[p.moveSession] = p.moveTo;
		run.charge(p.moveTo, p.sessionCost[p.moveSession], now);
	}
	trace.day[0] = run.day();
	trace.week[0] = run.week();
	for (let i = 1; i < len; i++) {
		const a = times[i - 1];
		const b = times[i];
		run.unserved = 0;
		if (b > a) {
			let total = 0;
			let fableTotal = 0;
			for (let x = demand.from[i]; x < demand.from[i + 1]; x++) {
				const bucket = demand.bucketIndex[x];
				total += units[bucket] * demand.bucketFrac[x];
				fableTotal += fable[bucket] * demand.bucketFrac[x];
			}
			const rate = total > 0 ? total / (b - a) : 0;
			const fableRatio = total > 0 ? Math.min(1, fableTotal / total) : 0;
			let t = a;
			while (t < b) {
				const end = Math.min(b, run.nextEvent(t));
				if (rate > 0) run.serve(t, end, rate, fableRatio, demand.attached[i]);
				t = end;
				if (t < b) run.applyDue(t);
			}
		}
		// The first of a jump pair is the value just before the jump.
		if (!(i + 1 < len && times[i + 1] === b)) run.applyDue(b);
		trace.day[i] = run.day();
		trace.week[i] = run.week();
		trace.unserved[i] = run.unserved;
	}
	trace.outs = run.outs;
	trace.fableOutAt = run.fableOutAt;
	return trace;
}

/** Runs every simulated day of ctx.scenarios under the plan; yields between blocks of days. */
export async function simulate(
	ctx: EngineContext,
	plan: SimPlan,
): Promise<SimulationResult> {
	const prepared = prepare(ctx, plan);
	const run = new DayRun(prepared);
	const traces: SimTrace[] = [];
	const days = ctx.scenarios.units.length;
	for (let s = 0; s < days; s++) {
		if (s > 0 && s % DAYS_PER_SLICE === 0) await yieldToEventLoop();
		traces.push(runDay(run, ctx.scenarios.units[s], ctx.scenarios.fable[s]));
	}
	return {
		axis: { times: prepared.times },
		accounts: ctx.accounts.map((account) => account.accountId),
		traces,
	};
}
