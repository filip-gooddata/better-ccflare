/**
 * One-time pass that fills the usage-detail tables for the past from the
 * Claude Code transcripts still on disk: token sums per bucket and model
 * family, and the ordered requests of each transcript file.
 *
 * Separate from the demand backfill: it never writes forecast_demand or that
 * backfill's meta keys. Its rows hold usage metadata only; a session appears
 * only as a salted key of the file's path relative to the root, and logs and
 * results carry counts only.
 */
import { relative } from "node:path";
import type { EpochMs, ModelFamily, TokenUsage } from "../types";
import { bucketStart, modelFamily } from "../units";
import {
	DEFAULT_SLICE_BUDGET_MS,
	DEFAULT_UPSERT_BATCH_SIZE,
	dirExists,
	emptyCounts,
	type ScannedResponse,
	Slicer,
	scanTranscripts,
	TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
	type TranscriptBackfillLog,
} from "./backfill";
import { type MetaAccess, sessionKey, sessionSalt } from "./session-key";
import {
	type SessionRequestRow,
	USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY,
	USAGE_DETAIL_BACKFILL_META_KEY,
	type UsageDetailDb,
	type UsageTokenRow,
} from "./usage-detail";

const DAY_MS = 24 * 60 * 60_000;

export interface UsageDetailBackfillDeps {
	db: Pick<UsageDetailDb, "upsertUsageTokens" | "upsertSessionRequests">;
	/** forecast_meta: the salt, the demand backfill's cut-over, this pass's coverage and marker. */
	meta: MetaAccess;
	/** Root of the transcripts; null or a missing directory makes the run a reported no-op. */
	transcriptsDir: string | null;
	/** Start of the earliest proxy-recorded bucket, or null when the proxy has recorded nothing. */
	earliestProxyBucket: () => Promise<EpochMs | null>;
	now: () => EpochMs;
	/** Rows older than now minus this many days are not written. */
	historyLookbackDays: number;
	log?: TranscriptBackfillLog;
	sliceBudgetMs?: number;
	/** Rows per upsert call. */
	upsertBatchSize?: number;
	readChunkBytes?: number;
}

export interface UsageDetailBackfillCounts {
	files: number;
	unreadable: number;
	lines: number;
	malformed: number;
	tokenRows: number;
	sessionRequests: number;
}

export type UsageDetailBackfillResult = {
	status: "already_done" | "no_dir" | "done";
} & UsageDetailBackfillCounts;

function zeroCounts(): UsageDetailBackfillCounts {
	return {
		files: 0,
		unreadable: 0,
		lines: 0,
		malformed: 0,
		tokenRows: 0,
		sessionRequests: 0,
	};
}

/** The demand backfill's stored cut-over, else the one it would choose now. */
async function cutover(deps: UsageDetailBackfillDeps): Promise<EpochMs> {
	const text = await deps.meta.getMeta(TRANSCRIPT_BACKFILL_CUTOVER_META_KEY);
	const stored = text === null ? Number.NaN : Number(text);
	if (Number.isFinite(stored)) return stored;
	return bucketStart((await deps.earliestProxyBucket()) ?? deps.now());
}

function splitOf(usage: TokenUsage): { m5: number; h1: number } {
	if (usage.cacheWrite5mTokens === null || usage.cacheWrite1hTokens === null) {
		return { m5: 0, h1: 0 };
	}
	return { m5: usage.cacheWrite5mTokens, h1: usage.cacheWrite1hTokens };
}

function tokenRows(
	all: ScannedResponse[],
	before: EpochMs,
	since: EpochMs,
): UsageTokenRow[] {
	const rows = new Map<string, UsageTokenRow>();
	for (const { at, usage } of all) {
		const start = bucketStart(at);
		if (start >= before || start < since) continue;
		const family: ModelFamily = modelFamily(usage.model);
		const id = `${start}|${family}`;
		let row = rows.get(id);
		if (row === undefined) {
			row = {
				bucketStart: start,
				accountId: "",
				source: "transcript",
				family,
				requestCount: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
			};
			rows.set(id, row);
		}
		const split = splitOf(usage);
		row.requestCount++;
		row.inputTokens += usage.inputTokens;
		row.outputTokens += usage.outputTokens;
		row.cacheReadTokens += usage.cacheReadTokens;
		row.cacheWriteTokens += usage.cacheWriteTokens;
		row.cacheWrite5mTokens += split.m5;
		row.cacheWrite1hTokens += split.h1;
	}
	return [...rows.values()].sort(
		(a, b) => a.bucketStart - b.bucketStart || a.family.localeCompare(b.family),
	);
}

/**
 * Rows of one file's responses, ascending by time; `seq` numbers the
 * responses that share a timestamp in line order.
 */
function fileRequests(
	key: string,
	responses: ScannedResponse[],
): SessionRequestRow[] {
	const ordered = [...responses].sort((x, y) => x.at - y.at || x.line - y.line);
	const rows: SessionRequestRow[] = [];
	let previous: SessionRequestRow | undefined;
	for (const { at, usage } of ordered) {
		const seq =
			previous !== undefined && previous.at === at ? previous.seq + 1 : 0;
		const split =
			usage.cacheWrite5mTokens !== null && usage.cacheWrite1hTokens !== null;
		previous = {
			source: "transcript",
			sessionKey: key,
			accountId: "",
			at,
			seq,
			family: modelFamily(usage.model),
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			cacheWrite5mTokens: split ? usage.cacheWrite5mTokens : null,
			cacheWrite1hTokens: split ? usage.cacheWrite1hTokens : null,
		};
		rows.push(previous);
	}
	return rows;
}

export async function runUsageDetailBackfill(
	deps: UsageDetailBackfillDeps,
): Promise<UsageDetailBackfillResult> {
	if ((await deps.meta.getMeta(USAGE_DETAIL_BACKFILL_META_KEY)) !== null) {
		return { status: "already_done", ...zeroCounts() };
	}
	const root = deps.transcriptsDir;
	if (root === null || !(await dirExists(root))) {
		deps.log?.info(
			"forecast usage detail backfill: no transcripts directory, skipped",
		);
		return { status: "no_dir", ...zeroCounts() };
	}

	const before = await cutover(deps);
	const since = deps.now() - deps.historyLookbackDays * DAY_MS;
	const salt = await sessionSalt(deps.meta);
	const slicer = new Slicer(deps.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS);
	const scanCounts = emptyCounts();
	const scan = await scanTranscripts(
		root,
		scanCounts,
		slicer,
		deps.readChunkBytes,
	);
	const all = [...scan.responses.values(), ...scan.unkeyed];

	const tokens = tokenRows(all, before, since);
	await slicer.maybeYield();

	const byFile = new Map<number, ScannedResponse[]>();
	for (const response of all) {
		const list = byFile.get(response.file);
		if (list === undefined) byFile.set(response.file, [response]);
		else list.push(response);
	}
	const requests: SessionRequestRow[] = [];
	for (const [file, responses] of [...byFile].sort(([x], [y]) => x - y)) {
		const path = scan.files[file] as string;
		const key = sessionKey(salt, "transcript", relative(root, path));
		for (const row of fileRequests(key, responses)) {
			if (row.at >= since) requests.push(row);
		}
		await slicer.maybeYield();
	}

	// Upserts replace by key and each row holds its full values, so a rerun
	// after an interruption ends with the same rows.
	const batchSize = Math.max(
		1,
		deps.upsertBatchSize ?? DEFAULT_UPSERT_BATCH_SIZE,
	);
	for (let i = 0; i < tokens.length; i += batchSize) {
		await deps.db.upsertUsageTokens(tokens.slice(i, i + batchSize));
		await slicer.maybeYield();
	}
	for (let i = 0; i < requests.length; i += batchSize) {
		await deps.db.upsertSessionRequests(requests.slice(i, i + batchSize));
		await slicer.maybeYield();
	}

	let firstAt: EpochMs | null = null;
	let lastAt: EpochMs | null = null;
	for (const { at } of requests) {
		if (firstAt === null || at < firstAt) firstAt = at;
		if (lastAt === null || at > lastAt) lastAt = at;
	}
	await deps.meta.setMeta(
		USAGE_DETAIL_BACKFILL_COVERAGE_META_KEY,
		JSON.stringify({
			files: scanCounts.files,
			lines: scanCounts.lines,
			requests: requests.length,
			firstAt,
			lastAt,
		}),
	);

	const counts: UsageDetailBackfillCounts = {
		files: scanCounts.files,
		unreadable: scanCounts.unreadable,
		lines: scanCounts.lines,
		malformed: scanCounts.malformed,
		tokenRows: tokens.length,
		sessionRequests: requests.length,
	};
	await deps.meta.setMeta(
		USAGE_DETAIL_BACKFILL_META_KEY,
		JSON.stringify({ completedAt: deps.now(), cutover: before, ...counts }),
	);
	deps.log?.info("forecast usage detail backfill: done", { ...counts });
	return { status: "done", ...counts };
}
