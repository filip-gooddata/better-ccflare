import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import type { ForecastDb } from "../ports";
import {
	PROXY_SYNC_LAST,
	PROXY_SYNC_MARKER,
	syncProxyDemand,
} from "../proxy-demand";
import { sessionKey } from "../session-key";
import {
	SESSION_SALT_META_KEY,
	type SessionRequestRow,
	USAGE_DETAIL_PROXY_SINCE_META_KEY,
	USAGE_DETAIL_PROXY_THROUGH_META_KEY,
	type UsageTokenRow,
} from "../usage-detail";

const MIN = 60_000;
const B = 5 * MIN;
/** A bucket boundary. */
const T0 = 1_800_000_000_000;
const SALT = "test-salt";
const FAR = T0 + 1000 * MIN;

const dirs: string[] = [];
const opened: DatabaseOperations[] = [];

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Req {
	id: string;
	account: string;
	at: number;
	model: string;
	session: string | null;
	/** input, output, cache read, cache write */
	tokens: [number, number, number, number];
	split?: [number | null, number | null];
}

async function openDb(salt: string | null = SALT): Promise<DatabaseOperations> {
	const dir = mkdtempSync(join(tmpdir(), "forecast-usage-detail-"));
	dirs.push(dir);
	const ops = new DatabaseOperations(join(dir, "test.db"));
	opened.push(ops);
	for (const [id, provider] of [
		["acct-a", "anthropic"],
		["acct-b", "anthropic"],
		["zai", "zai"],
	]) {
		await ops.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[
				id,
				id,
				provider,
				provider === "zai" ? "key" : `refresh-${id}`,
				provider === "zai" ? "key" : `access-${id}`,
			],
		);
	}
	if (salt) await ops.setForecastMeta(SESSION_SALT_META_KEY, salt);
	return ops;
}

async function insert(ops: DatabaseOperations, r: Req): Promise<void> {
	const [input, output, read, write] = r.tokens;
	const [m5, h1] = r.split ?? [null, null];
	await ops.getAdapter().run(
		`INSERT INTO requests (id, timestamp, method, path, account_used, model,
		   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
		   cache_creation_5m_input_tokens, cache_creation_1h_input_tokens, client_session_id)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			r.id,
			r.at,
			r.account,
			r.model,
			input,
			output,
			read,
			write,
			m5,
			h1,
			r.session,
		],
	);
}

async function remove(ops: DatabaseOperations, id: string): Promise<void> {
	await ops.getAdapter().run("DELETE FROM requests WHERE id = ?", [id]);
}

async function stored(db: ForecastDb) {
	return {
		tokens: await db.getUsageTokens("proxy", 0, FAR),
		sessions: await db.getSessionRequests("proxy", 0, FAR),
	};
}

const key = (session: string) => sessionKey(SALT, "proxy", session);

let n = 0;
function req(session: string | null, at: number, over: Partial<Req> = {}): Req {
	n++;
	return {
		id: `req-${n}`,
		account: "acct-a",
		at,
		model: "claude-opus-4-1",
		session,
		tokens: [10, 20, 100, 50],
		...over,
	};
}

describe("proxy usage detail", () => {
	let ops: DatabaseOperations;

	beforeEach(async () => {
		ops = await openDb();
	});

	afterEach(() => {
		for (const o of opened.splice(0)) o.dispose?.();
	});

	it("sums tokens per bucket, account and family, and splits only requests that reported the split", async () => {
		await insert(ops, req("s1", T0 + 1000, { split: [30, 20] }));
		await insert(
			ops,
			req("s1", T0 + 2000, { tokens: [1, 2, 3, 40], split: [null, null] }),
		);
		await insert(
			ops,
			req(null, T0 + 3000, {
				model: "claude-fable-5-2",
				tokens: [5, 6, 7, 8],
				split: [8, 0],
			}),
		);
		await insert(ops, req("s2", T0 + B + 1, { account: "acct-b" }));
		await insert(ops, req("s3", T0 + 1, { account: "zai", model: "glm-4.6" }));

		await syncProxyDemand({ db: ops }, T0 + 2 * B);

		const want: UsageTokenRow[] = [
			{
				bucketStart: T0,
				accountId: "acct-a",
				source: "proxy",
				family: "fable",
				requestCount: 1,
				inputTokens: 5,
				outputTokens: 6,
				cacheReadTokens: 7,
				cacheWriteTokens: 8,
				cacheWrite5mTokens: 8,
				cacheWrite1hTokens: 0,
			},
			{
				bucketStart: T0,
				accountId: "acct-a",
				source: "proxy",
				family: "opus",
				requestCount: 2,
				inputTokens: 11,
				outputTokens: 22,
				cacheReadTokens: 103,
				cacheWriteTokens: 90,
				cacheWrite5mTokens: 30,
				cacheWrite1hTokens: 20,
			},
			{
				bucketStart: T0 + B,
				accountId: "acct-b",
				source: "proxy",
				family: "opus",
				requestCount: 1,
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 100,
				cacheWriteTokens: 50,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
			},
		];
		expect((await stored(ops)).tokens).toEqual(want);
	});

	it("logs one row per request of a named session, in order, under an opaque key", async () => {
		await insert(
			ops,
			req("s1", T0, { tokens: [1, 1, 100, 40], split: [10, 30] }),
		);
		// two requests of s1 in the same millisecond: seq follows the request id
		await insert(
			ops,
			req("s1", T0 + 5000, {
				id: "req-a",
				model: "claude-haiku-4-5",
				tokens: [1, 1, 200, 5],
			}),
		);
		await insert(ops, req("s1", T0 + 5000, { id: "req-b" }));
		await insert(ops, req("s2", T0 + 5000, { account: "acct-b" }));
		await insert(ops, req(null, T0 + 6000));

		await syncProxyDemand({ db: ops }, T0 + 2 * B);

		const row = (
			session: string,
			at: number,
			seq: number,
			over: Partial<SessionRequestRow> = {},
		): SessionRequestRow => ({
			source: "proxy",
			sessionKey: key(session),
			accountId: "acct-a",
			at,
			seq,
			family: "opus",
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
			cacheWrite5mTokens: null,
			cacheWrite1hTokens: null,
			...over,
		});
		const want = [
			row("s1", T0, 0, {
				inputTokens: 1,
				outputTokens: 1,
				cacheWriteTokens: 40,
				cacheWrite5mTokens: 10,
				cacheWrite1hTokens: 30,
			}),
			row("s1", T0 + 5000, 0, {
				family: "haiku",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 200,
				cacheWriteTokens: 5,
			}),
			row("s1", T0 + 5000, 1),
			row("s2", T0 + 5000, 0, { accountId: "acct-b" }),
		].sort((a, b) =>
			a.sessionKey === b.sessionKey
				? a.at - b.at || a.seq - b.seq
				: a.sessionKey < b.sessionKey
					? -1
					: 1,
		);
		expect((await stored(ops)).sessions).toEqual(want);

		// Nothing stored names the raw session id.
		const dump = JSON.stringify(
			await ops.getAdapter().query("SELECT * FROM forecast_session_requests"),
		);
		expect(dump).not.toContain("s1");
		expect(dump).not.toContain("s2");
		expect(key("s1")).toMatch(/^[0-9a-f]{32}$/);
	});

	it("marks the first sync that recorded usage detail and never moves the mark", async () => {
		await syncProxyDemand({ db: ops }, T0);
		expect(await ops.getForecastMeta(USAGE_DETAIL_PROXY_SINCE_META_KEY)).toBe(
			String(T0),
		);
		await syncProxyDemand({ db: ops }, T0 + 30 * MIN);
		expect(await ops.getForecastMeta(USAGE_DETAIL_PROXY_SINCE_META_KEY)).toBe(
			String(T0),
		);
	});

	it("creates the salt when none is stored and keys with it", async () => {
		const fresh = await openDb(null);
		await insert(fresh, req("s1", T0));
		await syncProxyDemand({ db: fresh }, T0 + B);
		const salt = await fresh.getForecastMeta(SESSION_SALT_META_KEY);
		expect(salt).toMatch(/^[0-9a-f]{64}$/);
		const [row] = (await stored(fresh)).sessions;
		expect(row?.sessionKey).toBe(sessionKey(salt as string, "proxy", "s1"));
	});

	it("after any sequence of incremental syncs equals a single full recompute", async () => {
		const all: Req[] = [];
		const add = async (r: Req) => {
			all.push(r);
			await insert(ops, r);
		};

		// before the first sync
		await add(req("s1", T0 - 50 * MIN));
		await add(req("s1", T0 - 50 * MIN + 30_000, { split: [20, 30] }));
		await add(req(null, T0 - 40 * MIN));
		await add(req("s3", T0 - 5 * MIN, { account: "zai", model: "glm-4.6" }));
		await syncProxyDemand({ db: ops }, T0);

		// s2 runs every 50 s from T0 + 20 min to T0 + 50 min, across several syncs
		for (let t = T0 + 20 * MIN; t <= T0 + 50 * MIN; t += 50_000) {
			await add(
				req("s2", t, { account: "acct-b", model: "claude-sonnet-4-5" }),
			);
		}
		await add(req("s1", T0 + 29 * MIN));
		await add(req("s1", T0 + 29 * MIN + 30_000));
		await syncProxyDemand({ db: ops }, T0 + 30 * MIN);

		// a request lands in an already synced bucket, two in the same ms
		await add(req("s1", T0 + 30 * MIN + 10_000));
		await add(req("s1", T0 + 29 * MIN + 45_000));
		await add(req("s1", T0 + 29 * MIN + 45_000));
		await syncProxyDemand({ db: ops }, T0 + 100 * MIN);

		// a deleted request inside the next window
		const victim = all.find(
			(r) => r.session === "s2" && r.at === T0 + 20 * MIN + 30 * 50_000,
		);
		if (!victim) throw new Error("no victim");
		await remove(ops, victim.id);
		all.splice(all.indexOf(victim), 1);
		// s1 comes back after a long gap
		await add(req("s1", T0 + 170 * MIN));
		await add(req("s4", T0 + 170 * MIN + 1));
		await syncProxyDemand({ db: ops }, T0 + 175 * MIN);
		await syncProxyDemand({ db: ops }, T0 + 176 * MIN);

		const full = await openDb();
		for (const r of all) await insert(full, r);
		await syncProxyDemand({ db: full }, T0 + 176 * MIN);

		const incremental = await stored(ops);
		const once = await stored(full);
		expect(incremental).toEqual(once);

		// the scenario covers what it claims
		const named = all.filter((r) => r.session && r.account !== "zai");
		expect(once.sessions).toHaveLength(named.length);
		expect(
			once.sessions.filter((r) => r.sessionKey === key("s1")).map((r) => r.seq),
		).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
		expect(once.tokens.reduce((n, r) => n + r.requestCount, 0)).toBe(
			all.filter((r) => r.account !== "zai").length,
		);
	});

	it("leaves forecast_demand rows identical to a sync without the new recording", async () => {
		const requests = [
			req("s1", T0 - 70 * MIN, { split: [1, 2] }),
			req("s1", T0 - 10 * MIN),
			req(null, T0 + 1000, { model: "claude-fable-5-2" }),
			req("s2", T0 + 2000, { account: "acct-b", model: "claude-haiku-4-5" }),
		];
		const withDetail = ops;
		const plain = await openDb();
		for (const r of requests) {
			await insert(withDetail, r);
			await insert(plain, r);
		}
		const noDetail = new Proxy(plain as unknown as ForecastDb, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (
					typeof value === "function" &&
					[
						"replaceUsageTokens",
						"replaceSessionRequests",
						"upsertUsageTokens",
						"upsertSessionRequests",
					].includes(String(prop))
				) {
					return async () => [];
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		for (const now of [T0, T0 + 30 * MIN, T0 + 200 * MIN]) {
			await syncProxyDemand({ db: withDetail }, now);
			await syncProxyDemand({ db: noDetail }, now);
		}

		const dump = (o: DatabaseOperations) =>
			o
				.getAdapter()
				.query(
					"SELECT * FROM forecast_demand ORDER BY bucket_start, account_id, source",
				);
		const a = await dump(withDetail);
		expect(a.length).toBeGreaterThan(0);
		expect(JSON.stringify(a)).toBe(JSON.stringify(await dump(plain)));
		expect((await stored(withDetail)).sessions.length).toBeGreaterThan(0);
	});
});

const DAY = 24 * 60 * MIN;

/** Records each getClaudeOAuthRequestUsage range the sync asks for. */
function recording(db: ForecastDb, ranges: [number, number][]): ForecastDb {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			if (prop === "getClaudeOAuthRequestUsage") {
				return (from: number, to: number) => {
					ranges.push([from, to]);
					return value.call(target, from, to);
				};
			}
			return value.bind(target);
		},
	});
}

class DiskFullError extends Error {
	override name = "DiskFullError";
}

/** Throws from `method` while `failing.on`, with a message that must never surface. */
function failingDetail(
	db: ForecastDb,
	method: string,
	failing: { on: boolean },
): ForecastDb {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			if (prop === method) {
				return async (...args: unknown[]) => {
					if (failing.on) throw new DiskFullError("/private/secret path");
					return value.apply(target, args);
				};
			}
			return value.bind(target);
		},
	});
}

/** Drops every usage-detail write: the demand sync as it was before usage detail. */
function noDetail(db: ForecastDb): ForecastDb {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			if (
				["replaceUsageTokens", "replaceSessionRequests"].includes(String(prop))
			) {
				return async () => [];
			}
			return value.bind(target);
		},
	});
}

const demandDump = (o: DatabaseOperations) =>
	o
		.getAdapter()
		.query(
			"SELECT * FROM forecast_demand ORDER BY bucket_start, account_id, source",
		);

async function fullRecompute(all: Req[], now: number) {
	const full = await openDb();
	for (const r of all) await insert(full, r);
	await syncProxyDemand({ db: full }, now);
	return stored(full);
}

describe("proxy usage detail: catching up the history", () => {
	let ops: DatabaseOperations;

	beforeEach(async () => {
		ops = await openDb();
	});

	afterEach(() => {
		for (const o of opened.splice(0)) o.dispose?.();
	});

	it("fills all retained requests once on an install whose first demand sync ran long ago", async () => {
		const all = [
			req("s1", T0 - 3 * DAY),
			req("s1", T0 - 3 * DAY + 40_000, { split: [5, 6] }),
			req(null, T0 - 2 * DAY, { account: "acct-b" }),
			req("s2", T0 - 1 * DAY, { model: "claude-sonnet-4-5" }),
			req("s3", T0 - 20 * MIN),
		];
		for (const r of all) await insert(ops, r);
		await ops.setForecastMeta(PROXY_SYNC_MARKER, String(T0 - 4 * DAY));
		await ops.setForecastMeta(PROXY_SYNC_LAST, String(T0 - 5 * MIN));

		const ranges: [number, number][] = [];
		const db = recording(ops, ranges);
		const first = await syncProxyDemand({ db }, T0);
		expect(first.firstRun).toBe(false);
		expect(ranges).toEqual([
			[T0 - 65 * MIN, T0 + B],
			[0, T0 + B],
		]);
		expect(first.detailError).toBeUndefined();
		expect(await ops.getForecastMeta(USAGE_DETAIL_PROXY_THROUGH_META_KEY)).toBe(
			String(T0 + B),
		);
		expect(await stored(ops)).toEqual(await fullRecompute(all, T0));
		expect((await stored(ops)).sessions).toHaveLength(4);

		const later = req("s1", T0 + 7 * MIN);
		all.push(later);
		await insert(ops, later);
		ranges.length = 0;
		await syncProxyDemand({ db }, T0 + 10 * MIN);
		expect(ranges).toEqual([[T0 - 60 * MIN, T0 + 15 * MIN]]);
		expect(await ops.getForecastMeta(USAGE_DETAIL_PROXY_THROUGH_META_KEY)).toBe(
			String(T0 + 15 * MIN),
		);
		expect(await stored(ops)).toEqual(await fullRecompute(all, T0 + 10 * MIN));
	});

	for (const method of ["replaceUsageTokens", "replaceSessionRequests"]) {
		it(`a failing ${method} leaves the demand sync as without usage detail and is caught up later`, async () => {
			const plain = await openDb();
			const all: Req[] = [];
			const add = async (r: Req) => {
				all.push(r);
				await insert(ops, r);
				await insert(plain, r);
			};
			const failing = { on: false };
			const db = failingDetail(ops, method, failing);
			const bare = noDetail(plain);
			const meta = async (o: DatabaseOperations) => [
				await o.getForecastMeta(PROXY_SYNC_MARKER),
				await o.getForecastMeta(PROXY_SYNC_LAST),
			];
			const through = () =>
				ops.getForecastMeta(USAGE_DETAIL_PROXY_THROUGH_META_KEY);

			await add(req("s1", T0 - 2 * DAY));
			await add(req("s1", T0 - 10 * MIN));
			await syncProxyDemand({ db }, T0);
			await syncProxyDemand({ db: bare }, T0);
			expect(await through()).toBe(String(T0 + B));

			// usage detail fails over several syncs, long enough that the next
			// sync demand window no longer reaches the missed requests
			failing.on = true;
			await add(req("s2", T0 + 50 * MIN, { account: "acct-b" }));
			await add(req(null, T0 + 51 * MIN));
			for (const now of [T0 + 100 * MIN, T0 + 200 * MIN]) {
				const result = await syncProxyDemand({ db }, now);
				await syncProxyDemand({ db: bare }, now);
				expect(result.detailError).toBe("DiskFullError");
				expect(JSON.stringify(result)).not.toContain("secret");
				expect(await through()).toBe(String(T0 + B));
				expect(JSON.stringify(await demandDump(ops))).toBe(
					JSON.stringify(await demandDump(plain)),
				);
				expect(await meta(ops)).toEqual(await meta(plain));
			}

			failing.on = false;
			await add(req("s1", T0 + 290 * MIN));
			const ranges: [number, number][] = [];
			const ok = await syncProxyDemand(
				{ db: recording(db, ranges) },
				T0 + 300 * MIN,
			);
			expect(ok.detailError).toBeUndefined();
			expect(ranges).toEqual([
				[T0 + 140 * MIN, T0 + 305 * MIN],
				[T0 + B, T0 + 305 * MIN],
			]);
			expect(await through()).toBe(String(T0 + 305 * MIN));
			expect(await stored(ops)).toEqual(
				await fullRecompute(all, T0 + 300 * MIN),
			);
		});
	}

	it("a failure on the very first sync leaves through unset, so the next sync rebuilds everything", async () => {
		const all = [req("s1", T0 - 2 * DAY), req("s2", T0 - 1 * MIN)];
		for (const r of all) await insert(ops, r);
		const failing = { on: true };
		const db = failingDetail(ops, "replaceUsageTokens", failing);
		const result = await syncProxyDemand({ db }, T0);
		expect(result.detailError).toBe("DiskFullError");
		expect(await ops.getForecastMeta(PROXY_SYNC_MARKER)).toBe(String(T0));
		expect(
			await ops.getForecastMeta(USAGE_DETAIL_PROXY_THROUGH_META_KEY),
		).toBeNull();

		failing.on = false;
		const ranges: [number, number][] = [];
		await syncProxyDemand({ db: recording(db, ranges) }, T0 + 10 * MIN);
		expect(ranges).toEqual([
			[T0 - 60 * MIN, T0 + 15 * MIN],
			[0, T0 + 15 * MIN],
		]);
		expect(await stored(ops)).toEqual(await fullRecompute(all, T0 + 10 * MIN));
	});
});
