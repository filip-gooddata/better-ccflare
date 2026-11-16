/**
 * One-time backfill of demand history from Claude Code transcripts.
 *
 * Privacy: transcripts are private conversations. Only usage metadata is read
 * (timestamp, model, token counts, cache fields, message id, request id). No
 * line, file content, file path or parse error text ever reaches a log, an
 * error, the result or the store; problems are reported as counts.
 */
import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { localDayKey } from "../time";
import type {
	DemandStore,
	EpochMs,
	StoredDemandRow,
	TokenUsage,
} from "../types";
import { BUCKET_MS } from "../types";
import { bucketStart, demandUnits, isFableUsage } from "../units";
import { type ScannedLine, scanUsageLine } from "./backfill-scan";

/** Completion marker in forecast_meta; set only after every row is stored. */
export const TRANSCRIPT_BACKFILL_META_KEY = "transcript_backfill_done";
/** Cut-over chosen by the first attempt, reused by reruns after an interruption. */
export const TRANSCRIPT_BACKFILL_CUTOVER_META_KEY =
	"transcript_backfill_cutover";
/**
 * Bucket range `{from, until}` (until exclusive) that any attempt may have
 * written rows into; set before the rows, so it covers every stored row.
 */
export const TRANSCRIPT_BACKFILL_WRITTEN_META_KEY =
	"transcript_backfill_written";

export const DEFAULT_SLICE_BUDGET_MS = 30;
export const DEFAULT_UPSERT_BATCH_SIZE = 500;
const DEFAULT_READ_CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;
const USAGE_NEEDLE = Buffer.from('"usage"');

export interface TranscriptBackfillLog {
	info(msg: string, counts?: Record<string, number>): void;
	warn(msg: string, counts?: Record<string, number>): void;
}

export interface TranscriptBackfillDeps {
	store: DemandStore;
	/** Root of the transcripts; null or a missing directory makes the run a reported no-op. */
	transcriptsDir: string | null;
	/** Start of the earliest proxy-recorded bucket, or null when the proxy has recorded nothing. */
	earliestProxyBucket: () => Promise<EpochMs | null>;
	now: () => EpochMs;
	/** Zone of the local days counted in demandDays (default UTC). */
	timeZone?: string;
	log?: TranscriptBackfillLog;
	/** Longest stretch of synchronous work before yielding to the event loop. */
	sliceBudgetMs?: number;
	/** Rows per store.upsert call. */
	upsertBatchSize?: number;
	/** Bytes per file read; the slice budget also bounds work within one chunk. */
	readChunkBytes?: number;
}

export interface BackfillCounts {
	/** `*.jsonl` files read. */
	files: number;
	/** Files or directories that could not be read. */
	unreadable: number;
	/** Lines read. */
	lines: number;
	/** Lines that mention usage but are not one JSON object. */
	malformed: number;
	/** Lines without usable usage metadata (no usage, synthetic, bad timestamp). */
	skipped: number;
	/** Usage lines dropped as repeats of an already counted response. */
	deduped: number;
	/** Usage lines with neither message id nor request id, each counted as its own response. */
	unkeyed: number;
	/** Responses at or after the cut-over, not stored. */
	afterCutover: number;
	/** Distinct responses stored. */
	responses: number;
	/** Bucket rows upserted. */
	rows: number;
	/**
	 * Buckets zeroed because the cut-over moved earlier since an interrupted
	 * attempt: every bucket that attempt may have written at or after the new
	 * cut-over, whether or not this run could read its transcripts.
	 */
	cleared: number;
}

/**
 * "proxy": the earliest proxy bucket. "now": the proxy had recorded nothing,
 * so the current bucket. "resumed": kept from an earlier interrupted attempt.
 */
export type CutoverSource = "proxy" | "now" | "resumed";

export type BackfillResult =
	| ({ status: "already_done" | "no_dir" } & BackfillCounts)
	| ({
			status: "done";
			/** Only buckets strictly before this bucket start were stored. */
			cutover: EpochMs;
			cutoverSource: CutoverSource;
			/** Local days with stored demand (units above zero), and the first and last of them. */
			demandDays: number;
			firstDemandDay: string | null;
			lastDemandDay: string | null;
	  } & BackfillCounts);

export function emptyCounts(): BackfillCounts {
	return {
		files: 0,
		unreadable: 0,
		lines: 0,
		malformed: 0,
		skipped: 0,
		deduped: 0,
		unkeyed: 0,
		afterCutover: 0,
		responses: 0,
		rows: 0,
		cleared: 0,
	};
}

function countsRecord(counts: BackfillCounts): Record<string, number> {
	return { ...counts };
}

function tokens(value: number | null): number {
	return value !== null && value > 0 ? value : 0;
}

function nonEmpty(value: string | null): string | null {
	return value !== null && value.length > 0 ? value : null;
}

interface ParsedLine {
	at: EpochMs;
	key: string | null;
	usage: TokenUsage;
}

/** Usage metadata of one scanned line; null for lines that carry none. */
function usageMetadata(line: ScannedLine): ParsedLine | null {
	const usage = line.usage;
	if (usage === null) return null;
	const model = nonEmpty(line.model);
	if (model === "<synthetic>") return null;
	const at = line.timestamp === null ? Number.NaN : Date.parse(line.timestamp);
	if (!Number.isFinite(at)) return null;

	const messageId = nonEmpty(line.messageId);
	const requestId = nonEmpty(line.requestId);
	return {
		at,
		key:
			messageId === null && requestId === null
				? null
				: `${messageId ?? ""}\u0000${requestId ?? ""}`,
		usage: {
			model,
			inputTokens: tokens(usage.inputTokens),
			outputTokens: tokens(usage.outputTokens),
			cacheReadTokens: tokens(usage.cacheReadTokens),
			cacheWriteTokens: tokens(usage.cacheWriteTokens),
			cacheWrite5mTokens: usage.hasSplit ? usage.cacheWrite5mTokens : null,
			cacheWrite1hTokens: usage.hasSplit ? usage.cacheWrite1hTokens : null,
		},
	};
}

/**
 * The cut-over is fixed by the first attempt and kept in forecast_meta, so a
 * rerun after an interruption stores exactly the buckets the first attempt
 * would have. It only ever moves earlier: if the proxy has meanwhile recorded
 * an earlier bucket, transcript rows stop before that one, and `previous`
 * names the old cut-over so rows an earlier attempt wrote in between can be
 * cleared. The moved cut-over is persisted only after that clearing.
 */
async function resolveCutover(deps: TranscriptBackfillDeps): Promise<{
	cutover: EpochMs;
	source: CutoverSource;
	previous: EpochMs | null;
}> {
	const earliest = await deps.earliestProxyBucket();
	const fresh = bucketStart(earliest ?? deps.now());
	const source = earliest === null ? "now" : "proxy";
	const storedText = await deps.store.getMeta(
		TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
	);
	const stored = storedText === null ? Number.NaN : Number(storedText);
	if (!Number.isFinite(stored)) {
		await deps.store.setMeta(
			TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
			String(fresh),
		);
		return { cutover: fresh, source, previous: null };
	}
	if (stored <= fresh) {
		return { cutover: stored, source: "resumed", previous: null };
	}
	return { cutover: fresh, source, previous: stored };
}

interface WrittenRange {
	from: EpochMs;
	until: EpochMs;
}

async function readWrittenRange(
	store: DemandStore,
): Promise<WrittenRange | null> {
	const text = await store.getMeta(TRANSCRIPT_BACKFILL_WRITTEN_META_KEY);
	if (text === null) return null;
	let value: unknown = null;
	try {
		value = JSON.parse(text);
	} catch {}
	const range = value as Partial<WrittenRange> | null;
	if (
		typeof range?.from !== "number" ||
		typeof range.until !== "number" ||
		!Number.isFinite(range.from) ||
		!Number.isFinite(range.until)
	) {
		// Unparseable: assume nothing about where rows are; the caller clears
		// the whole span between the cut-overs.
		return { from: Number.NEGATIVE_INFINITY, until: Number.POSITIVE_INFINITY };
	}
	return { from: range.from, until: range.until };
}

export class Slicer {
	private sliceStart = performance.now();
	constructor(private readonly budgetMs: number) {}

	async maybeYield(): Promise<void> {
		if (performance.now() - this.sliceStart < this.budgetMs) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		this.sliceStart = performance.now();
	}
}

async function listTranscripts(
	root: string,
	counts: BackfillCounts,
	slicer: Slicer,
): Promise<string[]> {
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			counts.unreadable++;
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl"))
				files.push(path);
		}
		await slicer.maybeYield();
	}
	return files.sort();
}

/** Yields complete lines of a file as byte buffers, reading it in chunks. */
async function* fileLines(
	path: string,
	chunkBytes: number,
): AsyncGenerator<Buffer> {
	const handle = await open(path, "r");
	try {
		// The unfinished line so far; kept as parts so a line spanning many
		// chunks is joined once, not re-copied per chunk.
		let carry: Buffer[] = [];
		for (;;) {
			const chunk = Buffer.allocUnsafe(chunkBytes);
			const { bytesRead } = await handle.read(chunk, 0, chunkBytes, null);
			if (bytesRead === 0) break;
			const data = chunk.subarray(0, bytesRead);
			let start = 0;
			for (;;) {
				const end = data.indexOf(NEWLINE, start);
				if (end === -1) break;
				if (carry.length > 0) {
					yield Buffer.concat([...carry, data.subarray(start, end)]);
					carry = [];
				} else {
					yield data.subarray(start, end);
				}
				start = end + 1;
			}
			if (start < data.length) carry.push(data.subarray(start));
		}
		if (carry.length > 0) yield Buffer.concat(carry);
	} finally {
		await handle.close();
	}
}

/** One response kept after dedupe; `file` indexes TranscriptScan.files. */
export interface ScannedResponse {
	at: EpochMs;
	usage: TokenUsage;
	file: number;
	/** Position of the line it was first kept from, in reading order across all files. */
	line: number;
}

export interface TranscriptScan {
	/** The `*.jsonl` files, sorted, as listed under the root. */
	files: string[];
	/** Keyed responses, deduped by message id and request id. */
	responses: Map<string, ScannedResponse>;
	/** Responses with neither id, each its own response. */
	unkeyed: ScannedResponse[];
}

/**
 * Reads every transcript under `root` and dedupes its usage lines. A repeated
 * response keeps its first timestamp, the usage with the greatest output and
 * the file where it was first kept.
 */
export async function scanTranscripts(
	root: string,
	counts: BackfillCounts,
	slicer: Slicer,
	readChunkBytes?: number,
): Promise<TranscriptScan> {
	const chunkBytes = Math.max(1024, readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES);
	const responses = new Map<string, ScannedResponse>();
	const unkeyed: ScannedResponse[] = [];

	const files = await listTranscripts(root, counts, slicer);
	for (const [file, path] of files.entries()) {
		try {
			for await (const raw of fileLines(path, chunkBytes)) {
				counts.lines++;
				if (raw.indexOf(USAGE_NEEDLE) !== -1) {
					let scanned: ScannedLine | null = null;
					try {
						scanned = scanUsageLine(raw);
					} catch {
						// MalformedLineError only; its message holds no line content.
					}
					if (scanned === null) {
						counts.malformed++;
					} else {
						const line = usageMetadata(scanned);
						if (line === null) counts.skipped++;
						else if (line.key === null) {
							counts.unkeyed++;
							unkeyed.push({
								at: line.at,
								usage: line.usage,
								file,
								line: counts.lines,
							});
						} else {
							const seen = responses.get(line.key);
							if (seen === undefined) {
								responses.set(line.key, {
									at: line.at,
									usage: line.usage,
									file,
									line: counts.lines,
								});
							} else {
								counts.deduped++;
								// Streamed responses repeat their usage; the line with the most
								// output is the final one. The response starts at its first line.
								if (line.usage.outputTokens >= seen.usage.outputTokens) {
									seen.usage = line.usage;
								}
								seen.at = Math.min(seen.at, line.at);
							}
						}
					}
				} else if (raw.length > 0) {
					counts.skipped++;
				}
				await slicer.maybeYield();
			}
			counts.files++;
		} catch {
			counts.unreadable++;
		}
		await slicer.maybeYield();
	}
	return { files, responses, unkeyed };
}

export async function dirExists(path: string): Promise<boolean> {
	try {
		await readdir(path);
		return true;
	} catch {
		return false;
	}
}

export async function runTranscriptBackfill(
	deps: TranscriptBackfillDeps,
): Promise<BackfillResult> {
	const counts = emptyCounts();
	const log = deps.log;

	if ((await deps.store.getMeta(TRANSCRIPT_BACKFILL_META_KEY)) !== null) {
		return { status: "already_done", ...counts };
	}
	if (deps.transcriptsDir === null || !(await dirExists(deps.transcriptsDir))) {
		log?.info(
			"forecast transcript backfill: no transcripts directory, skipped",
		);
		return { status: "no_dir", ...counts };
	}

	const {
		cutover,
		source: cutoverSource,
		previous,
	} = await resolveCutover(deps);

	const slicer = new Slicer(deps.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS);
	const { responses, unkeyed } = await scanTranscripts(
		deps.transcriptsDir,
		counts,
		slicer,
		deps.readChunkBytes,
	);

	const buckets = new Map<EpochMs, StoredDemandRow>();
	for (const group of [responses.values(), unkeyed.values()]) {
		for (const response of group) {
			await slicer.maybeYield();
			const start = bucketStart(response.at);
			if (start >= cutover) {
				counts.afterCutover++;
				continue;
			}
			counts.responses++;
			let row = buckets.get(start);
			if (row === undefined) {
				row = {
					start,
					accountId: "",
					source: "transcript",
					units: 0,
					fableUnits: 0,
					requests: 0,
				};
				buckets.set(start, row);
			}
			const units = demandUnits(response.usage);
			row.units += units;
			if (isFableUsage(response.usage)) row.fableUnits += units;
			row.requests++;
		}
	}

	const batchSize = Math.max(
		1,
		deps.upsertBatchSize ?? DEFAULT_UPSERT_BATCH_SIZE,
	);
	const upsertAll = async (rows: StoredDemandRow[]): Promise<void> => {
		for (let i = 0; i < rows.length; i += batchSize) {
			await deps.store.upsert(rows.slice(i, i + batchSize));
			await slicer.maybeYield();
		}
	};

	const written = await readWrittenRange(deps.store);
	if (previous !== null) {
		// DemandStore cannot delete; an all-zero row replaces a stale transcript
		// row and adds nothing to any sum. The span comes from the recorded
		// written range, not from this run's scan, so a transcript that has
		// become unreadable cannot leave its old rows behind. Only after the
		// clearing is the new cut-over kept, so an interruption repeats it.
		const from = Math.max(cutover, written?.from ?? previous);
		const until = Math.min(previous, written?.until ?? cutover);
		let batch: StoredDemandRow[] = [];
		for (let start = from; start < until; start += BUCKET_MS) {
			batch.push({
				start,
				accountId: "",
				source: "transcript",
				units: 0,
				fableUnits: 0,
				requests: 0,
			});
			counts.cleared++;
			if (batch.length >= batchSize) {
				await upsertAll(batch);
				batch = [];
			}
		}
		await upsertAll(batch);
		await deps.store.setMeta(
			TRANSCRIPT_BACKFILL_CUTOVER_META_KEY,
			String(cutover),
		);
	}

	// Rows replace by (start, accountId, source) and each holds its bucket's
	// full total, so a rerun after an interruption rewrites the same values.
	const rows = [...buckets.values()].sort((a, b) => a.start - b.start);
	const first = rows[0];
	const last = rows.at(-1);
	if (first !== undefined && last !== undefined) {
		const span: WrittenRange = {
			from: Math.min(first.start, written?.from ?? first.start),
			until: Math.max(last.start + BUCKET_MS, written?.until ?? 0),
		};
		if (span.from !== written?.from || span.until !== written?.until) {
			await deps.store.setMeta(
				TRANSCRIPT_BACKFILL_WRITTEN_META_KEY,
				JSON.stringify(span),
			);
		}
	}
	await upsertAll(rows);
	counts.rows = rows.length;

	await deps.store.setMeta(
		TRANSCRIPT_BACKFILL_META_KEY,
		JSON.stringify({ completedAt: deps.now(), cutover, rows: counts.rows }),
	);
	if (counts.malformed > 0 || counts.unreadable > 0) {
		log?.warn("forecast transcript backfill: some input was unreadable", {
			malformed: counts.malformed,
			unreadable: counts.unreadable,
		});
	}
	log?.info("forecast transcript backfill: done", countsRecord(counts));
	const days = [
		...new Set(
			rows
				.filter((r) => r.units > 0)
				.map((r) => localDayKey(r.start, deps.timeZone ?? "UTC")),
		),
	].sort();
	return {
		status: "done",
		cutover,
		cutoverSource,
		...counts,
		demandDays: days.length,
		firstDemandDay: days[0] ?? null,
		lastDemandDay: days.at(-1) ?? null,
	};
}
