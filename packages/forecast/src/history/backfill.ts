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
import type {
	DemandStore,
	EpochMs,
	StoredDemandRow,
	TokenUsage,
} from "../types";
import { bucketStart, demandUnits, isFableUsage } from "../units";

export const TRANSCRIPT_BACKFILL_META_KEY = "transcript_backfill_done";

const DEFAULT_SLICE_BUDGET_MS = 30;
const DEFAULT_UPSERT_BATCH_SIZE = 500;
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
	/** Lines that mention usage but are not valid JSON. */
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
}

export type BackfillResult =
	| ({ status: "already_done" | "no_dir" } & BackfillCounts)
	| ({
			status: "done";
			/** Only buckets strictly before this bucket start were stored. */
			cutover: EpochMs;
			/** "proxy": earliest proxy bucket; "now": the proxy had recorded nothing yet. */
			cutoverSource: "proxy" | "now";
	  } & BackfillCounts);

interface Response {
	at: EpochMs;
	usage: TokenUsage;
}

function emptyCounts(): BackfillCounts {
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
	};
}

function countsRecord(counts: BackfillCounts): Record<string, number> {
	return { ...counts };
}

function tokens(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function splitTokens(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedLine {
	at: EpochMs;
	key: string | null;
	usage: TokenUsage;
}

/** Reads only usage metadata; returns null for lines that carry none. */
function usageMetadata(entry: unknown): ParsedLine | null {
	if (!isRecord(entry)) return null;
	const message = entry.message;
	if (!isRecord(message)) return null;
	const usage = message.usage;
	if (!isRecord(usage)) return null;
	const model = str(message.model);
	if (model === "<synthetic>") return null;
	const timestamp = str(entry.timestamp);
	const at = timestamp === null ? Number.NaN : Date.parse(timestamp);
	if (!Number.isFinite(at)) return null;

	const split = isRecord(usage.cache_creation) ? usage.cache_creation : null;
	const write5m = split ? splitTokens(split.ephemeral_5m_input_tokens) : null;
	const write1h = split ? splitTokens(split.ephemeral_1h_input_tokens) : null;
	const messageId = str(message.id);
	const requestId = str(entry.requestId);
	return {
		at,
		key:
			messageId === null && requestId === null
				? null
				: `${messageId ?? ""}\u0000${requestId ?? ""}`,
		usage: {
			model,
			inputTokens: tokens(usage.input_tokens),
			outputTokens: tokens(usage.output_tokens),
			cacheReadTokens: tokens(usage.cache_read_input_tokens),
			cacheWriteTokens: tokens(usage.cache_creation_input_tokens),
			cacheWrite5mTokens: write5m,
			cacheWrite1hTokens: write1h,
		},
	};
}

class Slicer {
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

async function dirExists(path: string): Promise<boolean> {
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

	const earliest = await deps.earliestProxyBucket();
	const cutover = bucketStart(earliest ?? deps.now());
	const cutoverSource = earliest === null ? "now" : "proxy";

	const slicer = new Slicer(deps.sliceBudgetMs ?? DEFAULT_SLICE_BUDGET_MS);
	const chunkBytes = Math.max(
		1024,
		deps.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES,
	);
	const responses = new Map<string, Response>();
	const unkeyed: Response[] = [];

	const files = await listTranscripts(deps.transcriptsDir, counts, slicer);
	for (const file of files) {
		try {
			for await (const raw of fileLines(file, chunkBytes)) {
				counts.lines++;
				if (raw.indexOf(USAGE_NEEDLE) !== -1) {
					let entry: unknown;
					let parsed = true;
					try {
						entry = JSON.parse(raw.toString("utf8"));
					} catch {
						parsed = false;
					}
					if (!parsed) {
						counts.malformed++;
					} else {
						const line = usageMetadata(entry);
						if (line === null) counts.skipped++;
						else if (line.key === null) {
							counts.unkeyed++;
							unkeyed.push({ at: line.at, usage: line.usage });
						} else {
							const seen = responses.get(line.key);
							if (seen === undefined) {
								responses.set(line.key, { at: line.at, usage: line.usage });
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

	const buckets = new Map<EpochMs, StoredDemandRow>();
	for (const response of [...responses.values(), ...unkeyed]) {
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
		await slicer.maybeYield();
	}

	// Rows replace by (start, accountId, source) and each holds its bucket's
	// full total, so a rerun after an interruption rewrites the same values.
	const rows = [...buckets.values()].sort((a, b) => a.start - b.start);
	const batchSize = Math.max(
		1,
		deps.upsertBatchSize ?? DEFAULT_UPSERT_BATCH_SIZE,
	);
	for (let i = 0; i < rows.length; i += batchSize) {
		await deps.store.upsert(rows.slice(i, i + batchSize));
		await slicer.maybeYield();
	}
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
	return { status: "done", cutover, cutoverSource, ...counts };
}
