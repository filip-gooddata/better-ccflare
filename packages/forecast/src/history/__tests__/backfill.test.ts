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
	TokenUsage,
} from "../../types";
import { BUCKET_MS } from "../../types";
import { bucketStart, demandUnits } from "../../units";
import {
	runTranscriptBackfill,
	TRANSCRIPT_BACKFILL_META_KEY,
	type TranscriptBackfillDeps,
} from "../backfill";

const CANARY = "CANARY-7f3a9c1e-private-text";
const T0 = Date.UTC(2026, 9, 5, 8, 0, 0);
const CUTOVER = T0 + 24 * 3_600_000;

class FakeStore implements DemandStore {
	rows = new Map<string, StoredDemandRow>();
	meta = new Map<string, string>();
	upsertCalls = 0;
	failOnUpsertCall: number | null = null;

	async upsert(rows: StoredDemandRow[]): Promise<void> {
		this.upsertCalls++;
		if (this.failOnUpsertCall === this.upsertCalls) {
			throw new Error("fake store failure");
		}
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
	async getMeta(key: string): Promise<string | null> {
		return this.meta.get(key) ?? null;
	}
	async setMeta(key: string, value: string): Promise<void> {
		this.meta.set(key, value);
	}
	sorted(): StoredDemandRow[] {
		return [...this.rows.values()].sort((a, b) => a.start - b.start);
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
	text?: string;
}

function assistantLine(spec: LineSpec): string {
	const usage: Record<string, unknown> = {
		input_tokens: spec.input ?? 100,
		output_tokens: spec.output ?? 50,
		cache_read_input_tokens: spec.cacheRead ?? 1000,
		cache_creation_input_tokens: spec.cacheWrite ?? 200,
		service_tier: "standard",
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
		type: "message",
		content: [{ type: "text", text: spec.text ?? `reply ${CANARY}` }],
		usage,
	};
	if (spec.messageId !== null) message.id = spec.messageId ?? "msg_1";
	const line: Record<string, unknown> = {
		type: "assistant",
		sessionId: "sess-1",
		uuid: crypto.randomUUID(),
		timestamp: new Date(spec.at).toISOString(),
		cwd: `/tmp/${CANARY}`,
		message,
	};
	if (spec.requestId !== null) line.requestId = spec.requestId ?? "req_1";
	return JSON.stringify(line);
}

function userLine(at: EpochMs): string {
	return JSON.stringify({
		type: "user",
		sessionId: "sess-1",
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: `please ${CANARY}` },
	});
}

function usageOf(spec: LineSpec): TokenUsage {
	return {
		model: spec.model ?? "claude-opus-5-5",
		inputTokens: spec.input ?? 100,
		outputTokens: spec.output ?? 50,
		cacheReadTokens: spec.cacheRead ?? 1000,
		cacheWriteTokens: spec.cacheWrite ?? 200,
		cacheWrite5mTokens: spec.split ? spec.split.m5 : null,
		cacheWrite1hTokens: spec.split ? spec.split.h1 : null,
	};
}

let dir: string;
let logs: unknown[][];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "forecast-backfill-"));
	logs = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function deps(
	store: DemandStore,
	overrides: Partial<TranscriptBackfillDeps> = {},
): TranscriptBackfillDeps {
	return {
		store,
		transcriptsDir: dir,
		earliestProxyBucket: async () => CUTOVER,
		now: () => CUTOVER + 3_600_000,
		log: {
			info: (...args: unknown[]) => logs.push(args),
			warn: (...args: unknown[]) => logs.push(args),
		},
		...overrides,
	};
}

async function writeJsonl(rel: string, lines: string[]): Promise<void> {
	const path = join(dir, rel);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`);
}

describe("runTranscriptBackfill", () => {
	test("aggregates usage into transcript buckets with units, fable units and requests", async () => {
		const a: LineSpec = {
			at: T0 + 10_000,
			messageId: "msg_a",
			requestId: "req_a",
		};
		const b: LineSpec = {
			at: T0 + 60_000,
			messageId: "msg_b",
			requestId: "req_b",
			model: "claude-fable-5-2",
			split: { m5: 150, h1: 50 },
		};
		const c: LineSpec = {
			at: T0 + BUCKET_MS + 1,
			messageId: "msg_c",
			requestId: "req_c",
			model: "claude-haiku-5-5",
		};
		await writeJsonl("proj-a/s1.jsonl", [
			userLine(T0),
			assistantLine(a),
			assistantLine(b),
		]);
		await writeJsonl("proj-b/nested/deeper/s2.jsonl", [assistantLine(c)]);
		await writeFile(join(dir, "proj-a", "notes.txt"), assistantLine(a));

		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));

		expect(store.sorted()).toEqual([
			{
				start: bucketStart(a.at),
				accountId: "",
				source: "transcript",
				units: demandUnits(usageOf(a)) + demandUnits(usageOf(b)),
				fableUnits: demandUnits(usageOf(b)),
				requests: 2,
			},
			{
				start: bucketStart(c.at),
				accountId: "",
				source: "transcript",
				units: demandUnits(usageOf(c)),
				fableUnits: 0,
				requests: 1,
			},
		]);
		expect(result.status).toBe("done");
		expect(result.files).toBe(2);
		expect(result.responses).toBe(3);
		expect(result.rows).toBe(2);
		expect(result.cutover).toBe(CUTOVER);
		expect(result.cutoverSource).toBe("proxy");
		expect(store.meta.get(TRANSCRIPT_BACKFILL_META_KEY)).toBeTruthy();
	});

	test("split fields are null when the transcript reports no cache_creation split", async () => {
		const spec: LineSpec = { at: T0, cacheWrite: 1_000_000, split: null };
		await writeJsonl("p/s.jsonl", [assistantLine(spec)]);
		const store = new FakeStore();
		await runTranscriptBackfill(deps(store));
		// unknown split counts at the 1-hour weight (units.ts)
		expect(store.sorted()[0]?.units).toBeCloseTo(
			demandUnits({
				...usageOf(spec),
				cacheWrite5mTokens: null,
				cacheWrite1hTokens: null,
			}),
			12,
		);
		expect(store.sorted()[0]?.units).not.toBeCloseTo(
			demandUnits({
				...usageOf(spec),
				cacheWrite5mTokens: 1_000_000,
				cacheWrite1hTokens: 0,
			}),
			6,
		);
	});

	test("repeated lines of one response count once, keeping the line with the most output", async () => {
		const first: LineSpec = {
			at: T0 + 1_000,
			messageId: "msg_x",
			requestId: "req_x",
			output: 3,
		};
		const last: LineSpec = {
			at: T0 + 2_000,
			messageId: "msg_x",
			requestId: "req_x",
			output: 400,
		};
		await writeJsonl("p/s.jsonl", [
			assistantLine(first),
			assistantLine(first),
			assistantLine(last),
		]);
		// a resumed session copies earlier lines into a new file
		await writeJsonl("p/s-resumed.jsonl", [assistantLine(first)]);

		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));

		const rows = store.sorted();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.requests).toBe(1);
		expect(rows[0]?.units).toBeCloseTo(demandUnits(usageOf(last)), 12);
		expect(result.responses).toBe(1);
		expect(result.deduped).toBe(3);
	});

	test("missing ids: one present id still dedupes; both missing counts each line", async () => {
		await writeJsonl("p/s.jsonl", [
			assistantLine({ at: T0, messageId: "msg_only", requestId: null }),
			assistantLine({ at: T0, messageId: "msg_only", requestId: null }),
			assistantLine({ at: T0, messageId: null, requestId: "req_only" }),
			assistantLine({ at: T0, messageId: null, requestId: "req_only" }),
			assistantLine({ at: T0, messageId: null, requestId: null }),
			assistantLine({ at: T0, messageId: null, requestId: null }),
		]);
		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));
		expect(store.sorted()[0]?.requests).toBe(4);
		expect(result.deduped).toBe(2);
		expect(result.unkeyed).toBe(2);
	});

	test("stores only buckets strictly before the earliest proxy bucket", async () => {
		await writeJsonl("p/s.jsonl", [
			assistantLine({ at: CUTOVER - 1, messageId: "m1" }),
			assistantLine({ at: CUTOVER, messageId: "m2" }),
			assistantLine({ at: CUTOVER + BUCKET_MS * 3, messageId: "m3" }),
		]);
		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));
		expect(store.sorted().map((r) => r.start)).toEqual([CUTOVER - BUCKET_MS]);
		expect(result.afterCutover).toBe(2);
	});

	test("an unaligned earliest proxy bucket cuts at the start of its bucket", async () => {
		await writeJsonl("p/s.jsonl", [
			assistantLine({ at: CUTOVER + 1, messageId: "m1" }),
			assistantLine({ at: CUTOVER - 1, messageId: "m2" }),
		]);
		const store = new FakeStore();
		await runTranscriptBackfill(
			deps(store, { earliestProxyBucket: async () => CUTOVER + 120_000 }),
		);
		expect(store.sorted().map((r) => r.start)).toEqual([CUTOVER - BUCKET_MS]);
	});

	test("with no proxy bucket yet, the cut-over is the start of the current bucket", async () => {
		const now = CUTOVER + 120_000;
		await writeJsonl("p/s.jsonl", [
			assistantLine({ at: CUTOVER - 1, messageId: "m1" }),
			assistantLine({ at: CUTOVER + 1, messageId: "m2" }),
		]);
		const store = new FakeStore();
		const result = await runTranscriptBackfill(
			deps(store, { earliestProxyBucket: async () => null, now: () => now }),
		);
		expect(result.cutover).toBe(CUTOVER);
		expect(result.cutoverSource).toBe("now");
		expect(store.sorted().map((r) => r.start)).toEqual([CUTOVER - BUCKET_MS]);
	});

	test("skips lines without usage, synthetic messages and bad timestamps", async () => {
		const noUsage = JSON.parse(assistantLine({ at: T0, messageId: "m0" }));
		delete noUsage.message.usage;
		const synthetic = JSON.parse(
			assistantLine({ at: T0, messageId: "m1", model: "<synthetic>" }),
		);
		const badTs = JSON.parse(assistantLine({ at: T0, messageId: "m2" }));
		badTs.timestamp = "not a date";
		await writeJsonl("p/s.jsonl", [
			JSON.stringify(noUsage),
			JSON.stringify(synthetic),
			JSON.stringify(badTs),
			userLine(T0),
			"",
			assistantLine({ at: T0, messageId: "m3" }),
		]);
		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));
		expect(store.sorted()[0]?.requests).toBe(1);
		expect(result.responses).toBe(1);
	});

	test("runs once: a set marker returns immediately without reading", async () => {
		await writeJsonl("p/s.jsonl", [assistantLine({ at: T0 })]);
		const store = new FakeStore();
		await store.setMeta(TRANSCRIPT_BACKFILL_META_KEY, "x");
		let asked = false;
		const result = await runTranscriptBackfill(
			deps(store, {
				earliestProxyBucket: async () => {
					asked = true;
					return CUTOVER;
				},
			}),
		);
		expect(result.status).toBe("already_done");
		expect(asked).toBe(false);
		expect(store.rows.size).toBe(0);
	});

	test("null or missing transcripts directory is a reported no-op without the marker", async () => {
		const store = new FakeStore();
		const r1 = await runTranscriptBackfill(
			deps(store, { transcriptsDir: null }),
		);
		const r2 = await runTranscriptBackfill(
			deps(store, { transcriptsDir: join(dir, "does-not-exist") }),
		);
		expect(r1.status).toBe("no_dir");
		expect(r2.status).toBe("no_dir");
		expect(store.rows.size).toBe(0);
		expect(store.meta.size).toBe(0);
		expect(logs.length).toBeGreaterThan(0);
	});

	test("lines spanning many read chunks and a last line without newline are read whole", async () => {
		const long: LineSpec = {
			at: T0,
			messageId: "m_long",
			text: "y".repeat(10_000),
		};
		const tail: LineSpec = { at: T0 + 1, messageId: "m_tail" };
		const path = join(dir, "p", "s.jsonl");
		await mkdir(join(dir, "p"), { recursive: true });
		await writeFile(
			path,
			`${assistantLine({ at: T0, messageId: "m_short" })}\n${assistantLine(long)}\n${assistantLine(tail)}`,
		);
		const store = new FakeStore();
		const result = await runTranscriptBackfill(
			deps(store, { readChunkBytes: 1024 }),
		);
		expect(result.malformed).toBe(0);
		expect(result.responses).toBe(3);
		expect(store.sorted()[0]?.requests).toBe(3);
	});

	test("an empty transcripts directory completes with zero rows and sets the marker", async () => {
		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));
		expect(result.status).toBe("done");
		expect(result.rows).toBe(0);
		expect(store.meta.has(TRANSCRIPT_BACKFILL_META_KEY)).toBe(true);
	});
});

describe("privacy", () => {
	test("message content and malformed lines never reach rows, logs, results or errors", async () => {
		const malformed = `{"type":"assistant","message":{"usage":{"input_tokens":1},"content":"${CANARY}"`;
		await writeJsonl(`p-${CANARY}/s-${CANARY}.jsonl`, [
			assistantLine({ at: T0, messageId: "m1", text: CANARY }),
			malformed,
			`not json at all ${CANARY} "usage"`,
			userLine(T0),
		]);

		const store = new FakeStore();
		const result = await runTranscriptBackfill(deps(store));
		expect(result.malformed).toBe(2);

		store.failOnUpsertCall = store.upsertCalls + 1;
		store.meta.clear();
		let thrown: unknown = null;
		try {
			await runTranscriptBackfill(deps(store));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).not.toBeNull();

		const everything = JSON.stringify({
			rows: store.sorted(),
			meta: [...store.meta.entries()],
			logs,
			result,
			thrown: String(thrown),
			stack: thrown instanceof Error ? thrown.stack : null,
			cause: thrown instanceof Error ? String(thrown.cause) : null,
		});
		expect(everything).not.toContain(CANARY);
		expect(everything).not.toContain("CANARY");
	});

	test("a failing earliestProxyBucket error is rethrown without transcript content", async () => {
		await writeJsonl("p/s.jsonl", [assistantLine({ at: T0 })]);
		const store = new FakeStore();
		await expect(
			runTranscriptBackfill(
				deps(store, {
					earliestProxyBucket: async () => {
						throw new Error("db down");
					},
				}),
			),
		).rejects.toThrow("db down");
		expect(store.meta.size).toBe(0);
	});
});

describe("resumability", () => {
	async function writeCorpus(): Promise<void> {
		for (let f = 0; f < 4; f++) {
			const lines: string[] = [];
			for (let i = 0; i < 300; i++) {
				const at = T0 + (f * 300 + i) * 37_000;
				lines.push(
					assistantLine({
						at,
						messageId: `msg_${f}_${i}`,
						requestId: `req_${f}_${i}`,
						model: i % 5 === 0 ? "claude-fable-5-2" : "claude-opus-5-5",
						output: i,
					}),
				);
				if (i % 7 === 0)
					lines.push(
						assistantLine({
							at,
							messageId: `msg_${f}_${i}`,
							requestId: `req_${f}_${i}`,
							output: i,
						}),
					);
			}
			await writeJsonl(`p${f}/s.jsonl`, lines);
		}
	}

	test("a store failure mid-run, then a rerun, ends with exactly the uninterrupted rows", async () => {
		await writeCorpus();
		const reference = new FakeStore();
		await runTranscriptBackfill(deps(reference, { upsertBatchSize: 10 }));
		expect(reference.upsertCalls).toBeGreaterThan(2);

		const store = new FakeStore();
		store.failOnUpsertCall = 2;
		await expect(
			runTranscriptBackfill(deps(store, { upsertBatchSize: 10 })),
		).rejects.toThrow();
		expect(store.meta.has(TRANSCRIPT_BACKFILL_META_KEY)).toBe(false);
		expect(store.rows.size).toBeGreaterThan(0);

		store.failOnUpsertCall = null;
		const result = await runTranscriptBackfill(
			deps(store, { upsertBatchSize: 10 }),
		);
		expect(result.status).toBe("done");
		expect(store.sorted()).toEqual(reference.sorted());
		expect(store.meta.has(TRANSCRIPT_BACKFILL_META_KEY)).toBe(true);

		const again = await runTranscriptBackfill(
			deps(store, { upsertBatchSize: 10 }),
		);
		expect(again.status).toBe("already_done");
		expect(store.sorted()).toEqual(reference.sorted());
	});

	test("a marker write failure leaves no marker and a rerun produces the same rows", async () => {
		await writeCorpus();
		const reference = new FakeStore();
		await runTranscriptBackfill(deps(reference));

		const store = new FakeStore();
		const realSet = store.setMeta.bind(store);
		store.setMeta = async (key, value) => {
			if (key === TRANSCRIPT_BACKFILL_META_KEY)
				throw new Error("meta write failed");
			await realSet(key, value);
		};
		await expect(runTranscriptBackfill(deps(store))).rejects.toThrow();
		expect(store.meta.has(TRANSCRIPT_BACKFILL_META_KEY)).toBe(false);
		expect(store.rows.size).toBeGreaterThan(0);
		store.setMeta = realSet;
		await runTranscriptBackfill(deps(store));
		expect(store.sorted()).toEqual(reference.sorted());
		expect(store.meta.has(TRANSCRIPT_BACKFILL_META_KEY)).toBe(true);
	});

	test("a rerun keeps the first attempt's cut-over when no proxy bucket existed", async () => {
		const now1 = CUTOVER + 60_000;
		const now2 = CUTOVER + 6 * 3_600_000;
		await writeCorpus();
		await writeJsonl("late/s.jsonl", [
			assistantLine({
				at: CUTOVER + 3_600_000,
				messageId: "late",
				requestId: "late",
			}),
		]);
		const noProxy = {
			earliestProxyBucket: async () => null,
			upsertBatchSize: 10,
		};

		const reference = new FakeStore();
		await runTranscriptBackfill(
			deps(reference, { ...noProxy, now: () => now1 }),
		);

		const store = new FakeStore();
		store.failOnUpsertCall = 2;
		await expect(
			runTranscriptBackfill(deps(store, { ...noProxy, now: () => now1 })),
		).rejects.toThrow();
		store.failOnUpsertCall = null;
		const result = await runTranscriptBackfill(
			deps(store, { ...noProxy, now: () => now2 }),
		);
		expect(result.status).toBe("done");
		if (result.status === "done") {
			expect(result.cutover).toBe(CUTOVER);
			expect(result.cutoverSource).toBe("resumed");
		}
		expect(store.sorted()).toEqual(reference.sorted());
	});

	test("a rerun moves the cut-over earlier when the proxy has since recorded an earlier bucket", async () => {
		await writeCorpus();
		const store = new FakeStore();
		store.failOnUpsertCall = 1;
		await expect(runTranscriptBackfill(deps(store))).rejects.toThrow();
		store.failOnUpsertCall = null;
		const earlier = T0 + 3_600_000;
		const result = await runTranscriptBackfill(
			deps(store, { earliestProxyBucket: async () => earlier }),
		);
		expect(result.status).toBe("done");
		if (result.status === "done") {
			expect(result.cutover).toBe(earlier);
			expect(result.cutoverSource).toBe("proxy");
		}
		expect(store.sorted().every((row) => row.start < earlier)).toBe(true);
		expect(store.sorted().length).toBeGreaterThan(0);
	});

	test("the marker is written only after every row is upserted", async () => {
		await writeCorpus();
		const store = new FakeStore();
		const events: string[] = [];
		const realUpsert = store.upsert.bind(store);
		store.upsert = async (rows) => {
			events.push("upsert");
			await realUpsert(rows);
		};
		store.setMeta = async (key, value) => {
			if (key === TRANSCRIPT_BACKFILL_META_KEY) events.push("marker");
			store.meta.set(key, value);
		};
		await runTranscriptBackfill(deps(store, { upsertBatchSize: 10 }));
		expect(events.at(-1)).toBe("marker");
		expect(events.filter((e) => e === "marker")).toHaveLength(1);
	});
});

describe("event loop", () => {
	test("never blocks the event loop for more than about 50 ms", async () => {
		// 60 000 usage lines and as many user lines, half of them after the cut-over.
		// A 64 MB read chunk puts each whole file into one synchronous stretch, so
		// only the slice budget keeps the event loop free; the control run without
		// a budget proves the data blocks long enough for the gap meter to notice.
		// A loaded machine can delay any timer, so the bound must hold in at least
		// one of three runs; a run that does not yield fails all three.
		const padding = "x".repeat(200);
		for (let f = 0; f < 2; f++) {
			const lines: string[] = [];
			for (let i = 0; i < 30_000; i++) {
				const at = T0 - (f * 30_000 + i) * 1_000;
				lines.push(
					assistantLine({
						at,
						messageId: `m_${f}_${i}`,
						requestId: `r_${f}_${i}`,
						text: padding,
					}),
				);
				lines.push(userLine(at));
			}
			await writeJsonl(`p${f % 3}/sub/s${f}.jsonl`, lines);
		}

		async function measure(
			overrides: Partial<TranscriptBackfillDeps>,
		): Promise<{ maxGap: number; responses: number }> {
			let maxGap = 0;
			let last = performance.now();
			const timer = setInterval(() => {
				const t = performance.now();
				maxGap = Math.max(maxGap, t - last);
				last = t;
			}, 1);
			try {
				const result = await runTranscriptBackfill(
					deps(new FakeStore(), {
						readChunkBytes: 64 << 20,
						earliestProxyBucket: async () => T0 - 30_000 * 1_000,
						...overrides,
					}),
				);
				return { maxGap, responses: result.responses + result.afterCutover };
			} finally {
				clearInterval(timer);
			}
		}

		const control = await measure({ sliceBudgetMs: 1e9 });
		expect(control.responses).toBe(60_000);
		expect(control.maxGap).toBeGreaterThan(60);

		// The default slice budget is 30 ms; one line's scan and the timer's own
		// latency come on top, so 60 ms leaves slack for a loaded machine.
		const gaps: number[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			const sliced = await measure({});
			expect(sliced.responses).toBe(60_000);
			gaps.push(sliced.maxGap);
			if (sliced.maxGap < 60) break;
		}
		expect(Math.min(...gaps)).toBeLessThan(60);
	}, 60_000);
});
