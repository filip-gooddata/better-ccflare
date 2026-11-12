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
import type { AccountDemandBucket, DemandBucket } from "../../types";
import {
	createDemandStore,
	earliestProxyBucket,
	type ForecastDb,
	loadReadings,
	PROXY_SYNC_LAST,
	PROXY_SYNC_MARKER,
	syncProxyDemand,
} from "../index";

const MIN = 60_000;
const B = 5 * MIN;
/** A bucket boundary. */
const T0 = 1_800_000_000_000;

const dirs: string[] = [];

function tempDb(): DatabaseOperations {
	const dir = mkdtempSync(join(tmpdir(), "forecast-store-"));
	dirs.push(dir);
	return new DatabaseOperations(join(dir, "test.db"));
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function expectBuckets<T extends DemandBucket>(actual: T[], expected: T[]) {
	expect(actual.length).toBe(expected.length);
	actual.forEach((bucket, i) => {
		const want = expected[i] as T;
		expect({ ...bucket, units: 0, fableUnits: 0 }).toEqual({
			...want,
			units: 0,
			fableUnits: 0,
		});
		expect(bucket.units).toBeCloseTo(want.units, 12);
		expect(bucket.fableUnits).toBeCloseTo(want.fableUnits, 12);
	});
}

describe("history store", () => {
	let dbOps: DatabaseOperations;
	let db: ForecastDb;
	let seq = 0;

	async function addAccount(
		id: string,
		provider: string,
		refreshToken: string | null,
		accessToken: string | null,
	) {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[id, id, provider, refreshToken, accessToken],
		);
	}

	async function addRequest(
		account: string,
		at: number,
		model: string | null,
		tokens: [number, number, number, number] | null,
	): Promise<string> {
		seq++;
		const id = `req-${seq}`;
		const [input, output, read, write] = tokens ?? [null, null, null, null];
		await dbOps.getAdapter().run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model,
			   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
			 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?)`,
			[id, at, account, model, input, output, read, write],
		);
		return id;
	}

	beforeEach(async () => {
		dbOps = tempDb();
		db = dbOps;
		await addAccount("acct-a", "anthropic", "refresh-a", "access-a");
		await addAccount("acct-b", "anthropic", "refresh-b", "access-b");
		await addAccount("zai", "zai", "key", "key");
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	describe("DemandStore", () => {
		it("round-trips rows, pools accounts and sources, and keeps meta", async () => {
			const store = createDemandStore({ db });
			expect(await store.earliest()).toBeNull();
			expect(await store.getMeta("m")).toBeNull();

			await store.upsert([
				{
					start: T0,
					accountId: "acct-a",
					source: "proxy",
					units: 1,
					fableUnits: 0.5,
					requests: 2,
				},
				{
					start: T0,
					accountId: "acct-b",
					source: "proxy",
					units: 2,
					fableUnits: 0,
					requests: 1,
				},
				{
					start: T0 - B,
					accountId: "",
					source: "transcript",
					units: 4,
					fableUnits: 1,
					requests: 3,
				},
				{
					start: T0 + B,
					accountId: "acct-a",
					source: "proxy",
					units: 0,
					fableUnits: 0,
					requests: 0,
				},
			]);
			await store.upsert([
				{
					start: T0,
					accountId: "acct-a",
					source: "proxy",
					units: 3,
					fableUnits: 1,
					requests: 4,
				},
			]);
			await store.setMeta("m", "v");

			expect(await store.loadPooled(T0 - B, T0 + 2 * B)).toEqual([
				{ start: T0 - B, units: 4, fableUnits: 1, requests: 3 },
				{ start: T0, units: 5, fableUnits: 1, requests: 5 },
			]);
			expect(await store.loadPooled(T0, T0 + B)).toEqual([
				{ start: T0, units: 5, fableUnits: 1, requests: 5 },
			]);
			expect(await store.loadByAccount(T0 - B, T0 + B)).toEqual([
				{
					start: T0,
					accountId: "acct-a",
					units: 3,
					fableUnits: 1,
					requests: 4,
				},
				{
					start: T0,
					accountId: "acct-b",
					units: 2,
					fableUnits: 0,
					requests: 1,
				},
			]);
			expect(await store.earliest()).toBe(T0 - B);
			expect(await store.getMeta("m")).toBe("v");
		});
	});

	describe("syncProxyDemand", () => {
		// now is 2 minutes into bucket T0; the trailing window is
		// [bucketStart(now - 60 min), T0 + B) = [T0 - 60 min, T0 + 5 min).
		const now = T0 + 2 * MIN;

		async function seed() {
			// opus: input 1000 + output 2000*5 + cache write 4000*2 (1-hour weight,
			// split unknown) + cache read 10000*0.1 = 20000 weighted -> 0.02 units
			await addRequest(
				"acct-a",
				T0 + 10_000,
				"claude-opus-4-1",
				[1000, 2000, 10_000, 4000],
			);
			// fable (factor 2): (100 + 1000*5) * 2 = 10200 -> 0.0102 units, all Fable
			await addRequest(
				"acct-a",
				T0 + 200_000,
				"claude-fable-5-2",
				[100, 1000, 0, 0],
			);
			// sonnet (0.6): 10000 * 0.6 = 6000 -> 0.006
			await addRequest(
				"acct-b",
				T0 - 10 * MIN,
				"claude-sonnet-4-5",
				[10_000, 0, 0, 0],
			);
			// haiku (0.2): 1000*5 * 0.2 = 1000 -> 0.001
			await addRequest(
				"acct-b",
				T0 - 10 * MIN + 10_000,
				"claude-haiku-4-5",
				[0, 1000, 0, 0],
			);
			// excluded: not a Claude OAuth account
			await addRequest("zai", T0 + 1000, "glm-4.6", [1_000_000, 0, 0, 0]);
			// excluded: no token usage
			await addRequest("acct-a", T0 + 5000, "claude-opus-4-1", null);
			// two hours back, outside the trailing window: opus input 1000 -> 0.001
			await addRequest(
				"acct-a",
				T0 - 120 * MIN,
				"claude-opus-4-1",
				[1000, 0, 0, 0],
			);
		}

		const firstRunRows: AccountDemandBucket[] = [
			{
				start: T0 - 120 * MIN,
				accountId: "acct-a",
				units: 0.001,
				fableUnits: 0,
				requests: 1,
			},
			{
				start: T0 - 10 * MIN,
				accountId: "acct-b",
				units: 0.007,
				fableUnits: 0,
				requests: 2,
			},
			{
				start: T0,
				accountId: "acct-a",
				units: 0.0302,
				fableUnits: 0.0102,
				requests: 2,
			},
		];

		it("first run aggregates everything the table holds and records the marker", async () => {
			await seed();
			const store = createDemandStore({ db });

			await syncProxyDemand({ db }, now);

			expectBuckets(await store.loadByAccount(0, T0 + B), firstRunRows);
			expectBuckets(await store.loadPooled(0, T0 + B), [
				{ start: T0 - 120 * MIN, units: 0.001, fableUnits: 0, requests: 1 },
				{ start: T0 - 10 * MIN, units: 0.007, fableUnits: 0, requests: 2 },
				{ start: T0, units: 0.0302, fableUnits: 0.0102, requests: 2 },
			]);
			expect(await store.getMeta(PROXY_SYNC_MARKER)).not.toBeNull();
		});

		it("is idempotent", async () => {
			await seed();
			const store = createDemandStore({ db });

			await syncProxyDemand({ db }, now);
			const once = await store.loadByAccount(0, T0 + B);
			const marker = await store.getMeta(PROXY_SYNC_MARKER);
			await syncProxyDemand({ db }, now);

			expect(await store.loadByAccount(0, T0 + B)).toEqual(once);
			expect(await store.getMeta(PROXY_SYNC_MARKER)).toBe(marker);
		});

		it("later runs recompute only whole buckets of the trailing window", async () => {
			await seed();
			const store = createDemandStore({ db });
			await syncProxyDemand({ db }, now);

			// before the window: ignored until a full resync
			await addRequest(
				"acct-b",
				T0 - 61 * MIN,
				"claude-opus-4-1",
				[5000, 0, 0, 0],
			);
			// first bucket of the window (now - 60 min is 2 minutes into it): counted
			await addRequest(
				"acct-b",
				T0 - 60 * MIN,
				"claude-opus-4-1",
				[3000, 0, 0, 0],
			);
			// a request removed from the table: its bucket loses it
			await dbOps
				.getAdapter()
				.run(
					"DELETE FROM requests WHERE account_used = 'acct-b' AND timestamp = ?",
					[T0 - 10 * MIN],
				);

			await syncProxyDemand({ db }, now);

			expectBuckets(await store.loadByAccount(0, T0 + B), [
				firstRunRows[0] as AccountDemandBucket,
				{
					start: T0 - 60 * MIN,
					accountId: "acct-b",
					units: 0.003,
					fableUnits: 0,
					requests: 1,
				},
				{
					start: T0 - 10 * MIN,
					accountId: "acct-b",
					units: 0.001,
					fableUnits: 0,
					requests: 1,
				},
				firstRunRows[2] as AccountDemandBucket,
			]);
		});

		it("catches up the requests of a gap longer than the window", async () => {
			await seed();
			const store = createDemandStore({ db });
			await syncProxyDemand({ db }, now);

			// served 30 minutes after the last run; the next run comes 3 hours later
			await addRequest(
				"acct-b",
				T0 + 32 * MIN,
				"claude-opus-4-1",
				[2000, 0, 0, 0],
			);
			const later = now + 180 * MIN;
			const result = await syncProxyDemand({ db }, later);

			expect(result.from).toBe(T0 - 60 * MIN);
			expectBuckets(await store.loadByAccount(T0 + 30 * MIN, T0 + 35 * MIN), [
				{
					start: T0 + 30 * MIN,
					accountId: "acct-b",
					units: 0.002,
					fableUnits: 0,
					requests: 1,
				},
			]);
			expect(await store.getMeta(PROXY_SYNC_LAST)).toBe(String(later));

			// back to the plain trailing window once the gap is closed
			expect((await syncProxyDemand({ db }, later)).from).toBe(T0 + 120 * MIN);
		});

		it("drops a bucket row whose requests are all gone", async () => {
			await seed();
			const store = createDemandStore({ db });
			await syncProxyDemand({ db }, now);

			await dbOps
				.getAdapter()
				.run("DELETE FROM requests WHERE account_used = 'acct-b'");
			await syncProxyDemand({ db }, now);

			expectBuckets(await store.loadByAccount(0, T0 + B), [
				firstRunRows[0] as AccountDemandBucket,
				firstRunRows[2] as AccountDemandBucket,
			]);
		});

		it("leaves transcript rows alone", async () => {
			await seed();
			const store = createDemandStore({ db });
			await store.upsert([
				{
					start: T0,
					accountId: "",
					source: "transcript",
					units: 1,
					fableUnits: 0,
					requests: 1,
				},
			]);

			await syncProxyDemand({ db }, now);

			expectBuckets(await store.loadPooled(T0, T0 + B), [
				{ start: T0, units: 1.0302, fableUnits: 0.0102, requests: 3 },
			]);
		});
	});

	describe("earliestProxyBucket", () => {
		it("is the earliest proxy bucket, ignoring transcript rows", async () => {
			const store = createDemandStore({ db });
			expect(await earliestProxyBucket({ db })).toBeNull();

			await store.upsert([
				{
					start: T0 - 10 * B,
					accountId: "",
					source: "transcript",
					units: 1,
					fableUnits: 0,
					requests: 1,
				},
			]);
			expect(await earliestProxyBucket({ db })).toBeNull();

			await store.upsert([
				{
					start: T0,
					accountId: "acct-a",
					source: "proxy",
					units: 1,
					fableUnits: 0,
					requests: 1,
				},
				{
					start: T0 - 2 * B,
					accountId: "acct-b",
					source: "proxy",
					units: 1,
					fableUnits: 0,
					requests: 1,
				},
			]);
			expect(await earliestProxyBucket({ db })).toBe(T0 - 2 * B);
		});
	});

	describe("loadReadings", () => {
		it("maps usage_snapshots rows of the three limit windows in [from, to)", async () => {
			const insert = (
				account: string,
				at: number,
				key: string,
				used: number,
				resetsAt: number | null,
			) =>
				dbOps
					.getAdapter()
					.run(
						"INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at) VALUES (?, ?, ?, ?, ?)",
						[account, at, key, used, resetsAt],
					);
			await insert("acct-a", T0, "five_hour", 42.5, T0 + 3 * 3_600_000);
			await insert("acct-a", T0, "seven_day", 12, T0 + 86_400_000);
			await insert("acct-b", T0 + MIN, "seven_day_fable", 80, null);
			await insert("acct-b", T0 + MIN, "seven_day_opus", 5, null);
			await insert("acct-b", T0 - 1, "five_hour", 1, null);
			await insert("acct-b", T0 + 2 * MIN, "five_hour", 2, null);

			expect(await loadReadings({ db }, T0, T0 + 2 * MIN)).toEqual([
				{
					accountId: "acct-a",
					at: T0,
					window: "five_hour",
					usedPct: 42.5,
					resetsAt: T0 + 3 * 3_600_000,
				},
				{
					accountId: "acct-a",
					at: T0,
					window: "seven_day",
					usedPct: 12,
					resetsAt: T0 + 86_400_000,
				},
				{
					accountId: "acct-b",
					at: T0 + MIN,
					window: "seven_day_fable",
					usedPct: 80,
					resetsAt: null,
				},
			]);
		});
	});
});
