import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AccountDemandBucket,
	DemandBucket,
	DemandStore,
	EpochMs,
	StoredDemandRow,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { bucketStart } from "../../units";
import {
	runTranscriptBackfill,
	TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
	TRANSCRIPT_BACKFILL_META_KEY,
} from "../backfill";
import { sessionKey } from "../session-key";
import {
	SESSION_SALT_META_KEY,
	type SessionRequestRow,
	USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY,
	USAGE_DETAIL_BACKFILL_META_KEY,
	type UsageDetailDb,
	type UsageDetailSource,
	type UsageTokenRow,
} from "../usage-detail";
import {
	runUsageDetailBackfill,
	type UsageDetailBackfillDeps,
} from "../usage-detail-backfill";

const MSG_TEXT = "MSGTEXT-c4f0e21b";
const SESSION_ID = "SESSID-9e7c55aa";
const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
const CUTOVER = T0 + DAY;
const NOW = CUTOVER + 3_600_000;
const SALT = "a".repeat(64);

class FakeMeta {
	meta = new Map<string, string>();
	writes: string[] = [];
	async getMeta(key: string): Promise<string | null> {
		return this.meta.get(key) ?? null;
	}
	async setMeta(key: string, value: string): Promise<void> {
		this.writes.push(key);
		this.meta.set(key, value);
	}
}

const requestId = (r: SessionRequestRow) =>
	`${r.source}|${r.sessionKey}|${r.at}|${r.seq}`;

class FakeUsageDetailDb implements UsageDetailDb {
	tokens = new Map<string, UsageTokenRow>();
	requests = new Map<string, SessionRequestRow>();
	/** Every session row in upsert order, repeats included. */
	requestWrites: SessionRequestRow[] = [];
	tokenCalls = 0;
	requestCalls = 0;
	failOnTokenCall: number | null = null;
	failOnRequestCall: number | null = null;

	async upsertUsageTokens(rows: UsageTokenRow[]): Promise<void> {
		this.tokenCalls++;
		if (this.failOnTokenCall === this.tokenCalls) throw new Error("fake fail");
		for (const r of rows) {
			this.tokens.set(
				`${r.bucketStart}|${r.accountId}|${r.source}|${r.family}`,
				{ ...r },
			);
		}
	}
	async upsertSessionRequests(rows: SessionRequestRow[]): Promise<void> {
		this.requestCalls++;
		if (this.failOnRequestCall === this.requestCalls)
			throw new Error("fake fail");
		for (const r of rows) {
			this.requests.set(requestId(r), { ...r });
			this.requestWrites.push({ ...r });
		}
	}
	async replaceUsageTokens(): Promise<void> {
		throw new Error("not used by the backfill");
	}
	async replaceSessionRequests(): Promise<void> {
		throw new Error("not used by the backfill");
	}
	async getSessionRequests(
		source: UsageDetailSource,
		from: EpochMs,
		to: EpochMs,
	): Promise<SessionRequestRow[]> {
		return [...this.requests.values()]
			.filter((r) => r.source === source && r.at >= from && r.at < to)
			.sort(
				(a, b) =>
					a.sessionKey.localeCompare(b.sessionKey) ||
					a.at - b.at ||
					a.seq - b.seq,
			);
	}
	async getUsageTokens(): Promise<UsageTokenRow[]> {
		return [];
	}
	async pruneUsageDetail(): Promise<void> {
		throw new Error("not used by the backfill");
	}
	sortedTokens(): UsageTokenRow[] {
		return [...this.tokens.values()].sort(
			(a, b) =>
				a.bucketStart - b.bucketStart || a.family.localeCompare(b.family),
		);
	}
	all(): Promise<SessionRequestRow[]> {
		return this.getSessionRequests("transcript", 0, Number.MAX_SAFE_INTEGER);
	}
}

class DemandFake extends FakeMeta implements DemandStore {
	rows = new Map<string, StoredDemandRow>();
	async upsert(rows: StoredDemandRow[]): Promise<void> {
		for (const row of rows) {
			this.rows.set(`${row.start}|${row.accountId}|${row.source}`, { ...row });
		}
	}
	async loadPooled(): Promise<DemandBucket[]> {
		return [];
	}
	async loadByAccount(): Promise<AccountDemandBucket[]> {
		return [];
	}
	async earliest(): Promise<EpochMs | null> {
		return null;
	}
}

interface LineSpec {
	at: EpochMs;
	model?: string;
	messageId?: string | null;
	requestId?: string | null;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	split?: { m5: number; h1: number } | null;
}

let seq = 0;
function line(spec: LineSpec): string {
	seq++;
	const usage: Record<string, unknown> = {
		input_tokens: spec.input ?? 100,
		output_tokens: spec.output ?? 50,
		cache_read_input_tokens: spec.cacheRead ?? 1000,
		cache_creation_input_tokens: spec.cacheWrite ?? 200,
	};
	if (spec.split) {
		usage.cache_creation = {
			ephemeral_5m_input_tokens: spec.split.m5,
			ephemeral_1h_input_tokens: spec.split.h1,
		};
	}
	const message: Record<string, unknown> = {
		model: spec.model ?? "claude-opus-5-5",
		role: "assistant",
		content: [{ type: "text", text: `reply ${MSG_TEXT}` }],
		usage,
	};
	if (spec.messageId !== null) message.id = spec.messageId ?? `msg_${seq}`;
	const out: Record<string, unknown> = {
		type: "assistant",
		sessionId: SESSION_ID,
		timestamp: new Date(spec.at).toISOString(),
		cwd: `/tmp/${MSG_TEXT}`,
		message,
	};
	if (spec.requestId !== null) out.requestId = spec.requestId ?? `req_${seq}`;
	return JSON.stringify(out);
}

function userLine(at: EpochMs): string {
	return JSON.stringify({
		type: "user",
		sessionId: SESSION_ID,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: `please ${MSG_TEXT}` },
	});
}

let dir: string;
let logs: unknown[][];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "forecast-usage-detail-"));
	logs = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeJsonl(rel: string, lines: string[]): Promise<void> {
	const path = join(dir, rel);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`);
}

function deps(
	db: UsageDetailDb,
	meta: FakeMeta,
	over: Partial<UsageDetailBackfillDeps> = {},
): UsageDetailBackfillDeps {
	return {
		db,
		meta,
		transcriptsDir: dir,
		earliestProxyBucket: async () => CUTOVER,
		now: () => NOW,
		historyLookbackDays: 56,
		log: {
			info: (...args: unknown[]) => logs.push(args),
			warn: (...args: unknown[]) => logs.push(args),
		},
		...over,
	};
}

function seeded(): FakeMeta {
	const meta = new FakeMeta();
	meta.meta.set(SESSION_SALT_META_KEY, SALT);
	return meta;
}

const key = (rel: string) => sessionKey(SALT, "transcript", rel);

describe("runUsageDetailBackfill: token rows", () => {
	test("sums categories per bucket and family; split sums count only lines that reported it", async () => {
		const b = bucketStart(T0);
		await writeJsonl("proj-a/one.jsonl", [
			userLine(T0),
			line({
				at: T0 + 1_000,
				input: 10,
				output: 20,
				cacheRead: 300,
				cacheWrite: 40,
				split: { m5: 30, h1: 10 },
			}),
			line({
				at: T0 + 2_000,
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 7,
			}),
			line({ at: T0 + 3_000, model: "claude-fable-5-2", cacheWrite: 5 }),
			line({ at: T0 + BUCKET_MS + 1, model: "claude-sonnet-5-5" }),
		]);
		const db = new FakeUsageDetailDb();
		const result = await runUsageDetailBackfill(deps(db, seeded()));
		expect(result.status).toBe("done");
		expect(db.sortedTokens()).toEqual([
			{
				bucketStart: b,
				accountId: "",
				source: "transcript",
				family: "fable",
				requestCount: 1,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 1000,
				cacheWriteTokens: 5,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
			},
			{
				bucketStart: b,
				accountId: "",
				source: "transcript",
				family: "opus",
				requestCount: 2,
				inputTokens: 11,
				outputTokens: 22,
				cacheReadTokens: 303,
				cacheWriteTokens: 47,
				cacheWrite5mTokens: 30,
				cacheWrite1hTokens: 10,
			},
			{
				bucketStart: b + BUCKET_MS,
				accountId: "",
				source: "transcript",
				family: "sonnet",
				requestCount: 1,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 1000,
				cacheWriteTokens: 200,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
			},
		]);
		expect(result).toMatchObject({ tokenRows: 3, files: 1, lines: 5 });
	});

	test("request counts per bucket equal the existing backfill's transcript request counts", async () => {
		await writeJsonl("a/x.jsonl", [
			line({ at: T0, messageId: "m1", requestId: "r1", output: 5 }),
			line({ at: T0 + 500, messageId: "m1", requestId: "r1", output: 90 }),
			line({ at: T0 + 2 * BUCKET_MS, model: "claude-haiku-4" }),
			line({ at: T0 + 3 * BUCKET_MS, messageId: null, requestId: null }),
			line({ at: CUTOVER + 10, model: "claude-fable-5-2" }),
		]);
		await writeJsonl("b/y.jsonl", [
			// The same response again in another file, earlier: one request.
			line({ at: T0 - 10, messageId: "m1", requestId: "r1", output: 40 }),
			line({ at: T0 + 2 * BUCKET_MS + 3, model: "claude-sonnet-5" }),
			line({ at: T0 + 4 * BUCKET_MS, model: "claude-fable-5-2" }),
		]);
		const store = new DemandFake();
		await runTranscriptBackfill({
			store,
			transcriptsDir: dir,
			earliestProxyBucket: async () => CUTOVER,
			now: () => NOW,
		});
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, seeded()));

		const fromTokens = new Map<number, number>();
		for (const r of db.tokens.values()) {
			fromTokens.set(
				r.bucketStart,
				(fromTokens.get(r.bucketStart) ?? 0) + r.requestCount,
			);
		}
		const fromDemand = new Map<number, number>();
		for (const r of store.rows.values()) fromDemand.set(r.start, r.requests);
		expect(fromDemand.size).toBeGreaterThan(3);
		expect(fromTokens).toEqual(fromDemand);
		for (const r of db.tokens.values())
			expect(r.bucketStart).toBeLessThan(CUTOVER);
	});

	test("the greatest-output repeat supplies the tokens, the first timestamp the bucket", async () => {
		await writeJsonl("a.jsonl", [
			line({
				at: T0 + BUCKET_MS - 1,
				messageId: "m",
				requestId: "r",
				output: 5,
			}),
			line({
				at: T0 + BUCKET_MS + 5,
				messageId: "m",
				requestId: "r",
				output: 70,
				input: 9,
			}),
		]);
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, seeded()));
		expect(db.sortedTokens()).toMatchObject([
			{
				bucketStart: bucketStart(T0),
				requestCount: 1,
				outputTokens: 70,
				inputTokens: 9,
			},
		]);
	});

	test("uses the existing backfill's stored cut-over when present", async () => {
		await writeJsonl("a.jsonl", [
			line({ at: T0 }),
			line({ at: T0 + 2 * BUCKET_MS }),
		]);
		const meta = seeded();
		meta.meta.set(
			TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
			String(bucketStart(T0) + BUCKET_MS),
		);
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, meta));
		expect(db.sortedTokens().map((r) => r.bucketStart)).toEqual([
			bucketStart(T0),
		]);
	});

	test("without a stored cut-over, computes it as the existing backfill does (proxy, else now)", async () => {
		await writeJsonl("a.jsonl", [
			line({ at: T0 }),
			line({ at: T0 + 2 * BUCKET_MS }),
		]);
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(
			deps(db, seeded(), {
				earliestProxyBucket: async () => T0 + BUCKET_MS + 7,
			}),
		);
		expect(db.sortedTokens().map((r) => r.bucketStart)).toEqual([
			bucketStart(T0),
		]);

		const db2 = new FakeUsageDetailDb();
		const meta2 = seeded();
		await runUsageDetailBackfill(
			deps(db2, meta2, {
				earliestProxyBucket: async () => null,
				now: () => T0 + 2 * BUCKET_MS + 9,
			}),
		);
		expect(db2.sortedTokens().map((r) => r.bucketStart)).toEqual([
			bucketStart(T0),
		]);
		// The pass never writes the existing backfill's cut-over.
		expect(meta2.meta.has(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY)).toBe(false);
	});
});

describe("runUsageDetailBackfill: session requests", () => {
	test("one row per deduped request over the whole span on disk, keyed per file", async () => {
		await writeJsonl("p/s1.jsonl", [
			userLine(T0),
			line({
				at: T0,
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 40,
				split: { m5: 30, h1: 10 },
			}),
			line({ at: T0 + 1_000, model: "claude-fable-5-2", cacheWrite: 7 }),
			// after the cut-over: still a session row
			line({ at: CUTOVER + 5_000, model: "claude-sonnet-5" }),
		]);
		await writeJsonl("p/sub/s2.jsonl", [
			line({ at: T0 + 30_000, model: "claude-haiku-4" }),
		]);
		const db = new FakeUsageDetailDb();
		const result = await runUsageDetailBackfill(deps(db, seeded()));
		const s1 = key("p/s1.jsonl");
		const s2 = key(join("p", "sub", "s2.jsonl"));
		const rows = await db.all();
		expect(rows.filter((r) => r.sessionKey === s1)).toEqual([
			{
				source: "transcript",
				sessionKey: s1,
				accountId: "",
				at: T0,
				seq: 0,
				family: "opus",
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 40,
				cacheWrite5mTokens: 30,
				cacheWrite1hTokens: 10,
			},
			{
				source: "transcript",
				sessionKey: s1,
				accountId: "",
				at: T0 + 1_000,
				seq: 0,
				family: "fable",
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 1000,
				cacheWriteTokens: 7,
				cacheWrite5mTokens: null,
				cacheWrite1hTokens: null,
			},
			{
				source: "transcript",
				sessionKey: s1,
				accountId: "",
				at: CUTOVER + 5_000,
				seq: 0,
				family: "sonnet",
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 1000,
				cacheWriteTokens: 200,
				cacheWrite5mTokens: null,
				cacheWrite1hTokens: null,
			},
		]);
		expect(rows.filter((r) => r.sessionKey === s2)).toMatchObject([
			{ at: T0 + 30_000, seq: 0, family: "haiku" },
		]);
		expect(rows.length).toBe(4);
		expect(result).toMatchObject({ sessionRequests: 4 });
	});

	test("a file with lines out of time order comes back ordered; seq numbers same-ms requests in line order", async () => {
		await writeJsonl("a.jsonl", [
			line({ at: T0 + 5_000, input: 1 }),
			line({ at: T0, input: 2 }),
			line({ at: T0 + 5_000, input: 3 }),
			line({ at: T0, input: 4, messageId: null, requestId: null }),
			line({ at: T0 - 9_000, input: 5 }),
		]);
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, seeded()));
		const expected = [
			{ at: T0 - 9_000, seq: 0, inputTokens: 5 },
			{ at: T0, seq: 0, inputTokens: 2 },
			{ at: T0, seq: 1, inputTokens: 4 },
			{ at: T0 + 5_000, seq: 0, inputTokens: 1 },
			{ at: T0 + 5_000, seq: 1, inputTokens: 3 },
		];
		const pick = (rows: SessionRequestRow[]) =>
			rows.map(({ at, seq, inputTokens }) => ({ at, seq, inputTokens }));
		expect(pick(await db.all())).toEqual(expected);
		// Written in that order too.
		expect(pick(db.requestWrites)).toEqual(expected);
	});

	test("a deduped request belongs to the file that kept it first, at its first timestamp", async () => {
		await writeJsonl("a.jsonl", [
			line({ at: T0 + 10_000 }),
			line({ at: T0 + 2_000, messageId: "dup", requestId: "dup", output: 1 }),
		]);
		await writeJsonl("b.jsonl", [
			line({ at: T0, messageId: "dup", requestId: "dup", output: 999 }),
			line({ at: T0 + 60_000 }),
		]);
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, seeded()));
		const rows = await db.all();
		const a = rows.filter((r) => r.sessionKey === key("a.jsonl"));
		const b = rows.filter((r) => r.sessionKey === key("b.jsonl"));
		expect(a.map((r) => [r.at, r.outputTokens])).toEqual([
			[T0, 999],
			[T0 + 10_000, 50],
		]);
		expect(b.map((r) => r.at)).toEqual([T0 + 60_000]);
	});

	test("creates the install salt when missing and keys sessions with it", async () => {
		await writeJsonl("a.jsonl", [line({ at: T0 })]);
		const meta = new FakeMeta();
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, meta));
		const salt = meta.meta.get(SESSION_SALT_META_KEY);
		expect(salt).toMatch(/^[0-9a-f]{64}$/);
		expect((await db.all())[0]?.sessionKey).toBe(
			sessionKey(salt as string, "transcript", "a.jsonl"),
		);
	});

	test("records coverage after the rows and before the done marker", async () => {
		await writeJsonl("a.jsonl", [
			userLine(T0),
			line({ at: T0 + 7 }),
			line({ at: CUTOVER + 9 }),
		]);
		await writeJsonl("b.jsonl", [line({ at: T0 - 3 })]);
		const meta = seeded();
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, meta));
		expect(
			JSON.parse(meta.meta.get(USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY) ?? ""),
		).toEqual({
			files: 2,
			lines: 4,
			requests: 3,
			firstAt: T0 - 3,
			lastAt: CUTOVER + 9,
		});
		expect(meta.writes).toEqual([
			USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY,
			USAGE_DETAIL_BACKFILL_META_KEY,
		]);
	});
});

describe("runUsageDetailBackfill: retention", () => {
	test("skips token rows and session rows older than now minus historyLookbackDays", async () => {
		const days = 10;
		const limit = NOW - days * DAY;
		await writeJsonl("old.jsonl", [
			line({ at: limit - 2 * BUCKET_MS }),
			line({ at: limit - 2 * BUCKET_MS + 1_000 }),
		]);
		await writeJsonl("mixed.jsonl", [
			line({ at: limit - 3 * 60_000 }),
			line({ at: limit + BUCKET_MS }),
		]);
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(
			deps(db, seeded(), { historyLookbackDays: days }),
		);
		expect(db.sortedTokens().map((r) => r.bucketStart)).toEqual([
			bucketStart(limit + BUCKET_MS),
		]);
		const rows = await db.all();
		expect(rows.map((r) => [r.sessionKey, r.at])).toEqual([
			[key("mixed.jsonl"), limit + BUCKET_MS],
		]);
	});
});

describe("runUsageDetailBackfill: marker and reruns", () => {
	test("returns already_done before any directory work when the marker is set", async () => {
		await writeJsonl("a.jsonl", [line({ at: T0 })]);
		const meta = seeded();
		meta.meta.set(USAGE_DETAIL_BACKFILL_META_KEY, "{}");
		const db = new FakeUsageDetailDb();
		let proxyAsked = false;
		const result = await runUsageDetailBackfill(
			deps(db, meta, {
				earliestProxyBucket: async () => {
					proxyAsked = true;
					return CUTOVER;
				},
			}),
		);
		expect(result).toMatchObject({
			status: "already_done",
			files: 0,
			lines: 0,
		});
		expect(proxyAsked).toBe(false);
		expect(db.tokenCalls + db.requestCalls).toBe(0);
		expect(meta.writes).toEqual([]);
	});

	test("reports no_dir for a missing directory and sets no marker", async () => {
		const meta = seeded();
		const db = new FakeUsageDetailDb();
		const result = await runUsageDetailBackfill(
			deps(db, meta, { transcriptsDir: join(dir, "missing") }),
		);
		expect(result.status).toBe("no_dir");
		expect(meta.meta.has(USAGE_DETAIL_BACKFILL_META_KEY)).toBe(false);
	});

	test("sets the marker after all upserts, in batches; a second run changes nothing", async () => {
		await writeJsonl("a.jsonl", [
			line({ at: T0 }),
			line({ at: T0 + BUCKET_MS }),
			line({ at: T0 + 2 * BUCKET_MS }),
		]);
		const meta = seeded();
		const db = new FakeUsageDetailDb();
		const result = await runUsageDetailBackfill(
			deps(db, meta, { upsertBatchSize: 1 }),
		);
		expect(result.status).toBe("done");
		expect(db.tokenCalls).toBe(3);
		expect(db.requestCalls).toBe(3);
		expect(meta.meta.has(USAGE_DETAIL_BACKFILL_META_KEY)).toBe(true);
		const snapshot = async () =>
			JSON.stringify([db.sortedTokens(), await db.all(), [...meta.meta]]);
		const before = await snapshot();
		await writeJsonl("later.jsonl", [line({ at: T0 + 3 * BUCKET_MS })]);
		const again = await runUsageDetailBackfill(
			deps(db, meta, { upsertBatchSize: 1 }),
		);
		expect(again.status).toBe("already_done");
		expect(await snapshot()).toBe(before);
	});

	test("a failure mid-way leaves no marker; the retry ends with the rows of a clean run", async () => {
		await writeJsonl("a.jsonl", [
			line({ at: T0 }),
			line({ at: T0 + BUCKET_MS, split: { m5: 1, h1: 2 } }),
			line({ at: T0 + 5 * BUCKET_MS }),
		]);
		await writeJsonl("b.jsonl", [
			line({ at: T0 + 2_000, model: "claude-fable-5-2" }),
		]);

		const clean = new FakeUsageDetailDb();
		const cleanMeta = seeded();
		await runUsageDetailBackfill(
			deps(clean, cleanMeta, { upsertBatchSize: 1 }),
		);

		for (const fail of ["token", "request"] as const) {
			const meta = seeded();
			const db = new FakeUsageDetailDb();
			if (fail === "token") db.failOnTokenCall = 2;
			else db.failOnRequestCall = 2;
			await expect(
				runUsageDetailBackfill(deps(db, meta, { upsertBatchSize: 1 })),
			).rejects.toThrow();
			expect(meta.meta.has(USAGE_DETAIL_BACKFILL_META_KEY)).toBe(false);
			expect(meta.meta.has(USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY)).toBe(
				false,
			);
			db.failOnTokenCall = null;
			db.failOnRequestCall = null;
			const retry = await runUsageDetailBackfill(
				deps(db, meta, { upsertBatchSize: 1 }),
			);
			expect(retry.status).toBe("done");
			expect(db.sortedTokens()).toEqual(clean.sortedTokens());
			expect(await db.all()).toEqual(await clean.all());
			expect(meta.meta.get(USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY)).toBe(
				cleanMeta.meta.get(USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY),
			);
		}
	});

	test("touches no forecast_demand marker or cut-over: only the salt, coverage and its own marker", async () => {
		await writeJsonl("a.jsonl", [line({ at: T0 })]);
		const meta = new FakeMeta();
		meta.meta.set(TRANSCRIPT_BACKFILL_META_KEY, '{"rows":3}');
		meta.meta.set(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY, String(CUTOVER));
		const db = new FakeUsageDetailDb();
		await runUsageDetailBackfill(deps(db, meta));
		expect([...new Set(meta.writes)].sort()).toEqual(
			[
				SESSION_SALT_META_KEY,
				USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY,
				USAGE_DETAIL_BACKFILL_META_KEY,
			].sort(),
		);
		expect(meta.meta.get(TRANSCRIPT_BACKFILL_META_KEY)).toBe('{"rows":3}');
		expect(meta.meta.get(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY)).toBe(
			String(CUTOVER),
		);
	});
});

describe("runUsageDetailBackfill: privacy", () => {
	test("no session id, file name, directory name or message text reaches rows, meta, logs or the result", async () => {
		const dirName = "DIRNAME-77d1a0f3";
		const fileName = "FILENAME-3b2a9c6e";
		await writeJsonl(`${dirName}/${fileName}.jsonl`, [
			userLine(T0),
			line({ at: T0 }),
			line({ at: T0 + 1_000, split: { m5: 1, h1: 1 } }),
			"{not json usage",
			`{"usage": "${MSG_TEXT}"`,
		]);
		const meta = seeded();
		const db = new FakeUsageDetailDb();
		const result = await runUsageDetailBackfill(deps(db, meta));
		expect(db.requests.size).toBe(2);
		const stored = [
			...db.tokens.values(),
			...db.requests.values(),
			...db.requestWrites,
		].flatMap((row) => Object.values(row).map(String));
		const metaValues = [...meta.meta]
			.filter(([k]) => k !== SESSION_SALT_META_KEY)
			.flat();
		const logged = logs.map((args) => JSON.stringify(args));
		const everything = [
			...stored,
			...metaValues,
			...logged,
			JSON.stringify(result),
		];
		expect(everything.length).toBeGreaterThan(20);
		for (const text of everything) {
			for (const secret of [
				SESSION_ID,
				dirName,
				fileName,
				MSG_TEXT,
				dir,
				".jsonl",
			]) {
				expect(text).not.toContain(secret);
			}
		}
	});
});
