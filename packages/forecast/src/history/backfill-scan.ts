/**
 * Reads the usage metadata of one transcript line without decoding anything
 * else. Values of keys other than the few metadata fields (message content,
 * tool input, tool results) are stepped over byte by byte and never turned
 * into strings, so message text is neither copied nor parsed.
 */

export interface ScannedUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/** True when usage.cache_creation is an object (the transcript reports the split). */
	hasSplit: boolean;
	cacheWrite5mTokens: number | null;
	cacheWrite1hTokens: number | null;
}

export interface ScannedLine {
	timestamp: string | null;
	requestId: string | null;
	messageId: string | null;
	model: string | null;
	/** null when the line has no message.usage object. */
	usage: ScannedUsage | null;
}

/** Fixed message on purpose: a scan error never carries line content. */
export class MalformedLineError extends Error {
	constructor() {
		super("malformed transcript line");
		this.name = "MalformedLineError";
	}
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
/** Longest key or metadata string decoded; longer ones are skipped as unknown. */
const MAX_DECODED_BYTES = 256;

function malformed(): never {
	throw new MalformedLineError();
}

function isSpace(c: number | undefined): boolean {
	return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function skipSpace(b: Buffer, i: number): number {
	while (isSpace(b[i])) i++;
	return i;
}

/** b[i] is the opening quote; returns the index after the closing quote. */
function skipString(b: Buffer, i: number): number {
	let from = i + 1;
	for (;;) {
		const q = b.indexOf(QUOTE, from);
		if (q === -1) malformed();
		let k = q - 1;
		while (b[k] === BACKSLASH) k--;
		if ((q - 1 - k) % 2 === 0) return q + 1;
		from = q + 1;
	}
}

function skipScalar(b: Buffer, i: number): number {
	let j = i;
	while (j < b.length) {
		const c = b[j];
		if (c === COMMA || c === CLOSE_BRACE || c === CLOSE_BRACKET || isSpace(c))
			break;
		if (c === QUOTE || c === OPEN_BRACE || c === OPEN_BRACKET) malformed();
		j++;
	}
	if (j === i) malformed();
	return j;
}

function skipNested(b: Buffer, i: number): number {
	let depth = 0;
	let j = i;
	while (j < b.length) {
		const c = b[j];
		if (c === QUOTE) {
			j = skipString(b, j);
			continue;
		}
		if (c === OPEN_BRACE || c === OPEN_BRACKET) depth++;
		else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
			depth--;
			if (depth === 0) return j + 1;
		}
		j++;
	}
	return malformed();
}

function skipValue(b: Buffer, i: number): number {
	const c = b[i];
	if (c === QUOTE) return skipString(b, i);
	if (c === OPEN_BRACE || c === OPEN_BRACKET) return skipNested(b, i);
	return skipScalar(b, i);
}

/** Decodes a short string value; longer or non-string values give null. */
function readString(
	b: Buffer,
	i: number,
): { value: string | null; end: number } {
	if (b[i] !== QUOTE) return { value: null, end: skipValue(b, i) };
	const end = skipString(b, i);
	if (end - i > MAX_DECODED_BYTES) return { value: null, end };
	try {
		const value: unknown = JSON.parse(b.toString("utf8", i, end));
		return { value: typeof value === "string" ? value : null, end };
	} catch {
		return malformed();
	}
}

function readNumber(
	b: Buffer,
	i: number,
): { value: number | null; end: number } {
	const c = b[i];
	if (c === QUOTE || c === OPEN_BRACE || c === OPEN_BRACKET) {
		return { value: null, end: skipValue(b, i) };
	}
	const end = skipScalar(b, i);
	const value = Number(b.toString("latin1", i, end));
	return { value: Number.isFinite(value) ? value : null, end };
}

/**
 * Walks the object starting at b[i] ('{'). For each key, `onValue` gets the
 * decoded key (null when it is too long to be a metadata key) and the value
 * start, and returns the value end.
 */
function scanObject(
	b: Buffer,
	i: number,
	onValue: (key: string | null, start: number) => number,
): number {
	if (b[i] !== OPEN_BRACE) malformed();
	let j = skipSpace(b, i + 1);
	if (b[j] === CLOSE_BRACE) return j + 1;
	for (;;) {
		if (b[j] !== QUOTE) malformed();
		const key = readString(b, j);
		j = skipSpace(b, key.end);
		if (b[j] !== COLON) malformed();
		j = skipSpace(b, j + 1);
		if (j >= b.length) malformed();
		j = skipSpace(b, onValue(key.value, j));
		if (b[j] === COMMA) {
			j = skipSpace(b, j + 1);
			continue;
		}
		if (b[j] === CLOSE_BRACE) return j + 1;
		return malformed();
	}
}

function scanSplit(b: Buffer, i: number, usage: ScannedUsage): number {
	return scanObject(b, i, (key, start) => {
		if (key === "ephemeral_5m_input_tokens") {
			const r = readNumber(b, start);
			usage.cacheWrite5mTokens = r.value;
			return r.end;
		}
		if (key === "ephemeral_1h_input_tokens") {
			const r = readNumber(b, start);
			usage.cacheWrite1hTokens = r.value;
			return r.end;
		}
		return skipValue(b, start);
	});
}

function scanUsage(b: Buffer, i: number): { usage: ScannedUsage; end: number } {
	const usage: ScannedUsage = {
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		hasSplit: false,
		cacheWrite5mTokens: null,
		cacheWrite1hTokens: null,
	};
	const end = scanObject(b, i, (key, start) => {
		switch (key) {
			case "input_tokens":
			case "output_tokens":
			case "cache_read_input_tokens":
			case "cache_creation_input_tokens": {
				const r = readNumber(b, start);
				if (key === "input_tokens") usage.inputTokens = r.value;
				else if (key === "output_tokens") usage.outputTokens = r.value;
				else if (key === "cache_read_input_tokens")
					usage.cacheReadTokens = r.value;
				else usage.cacheWriteTokens = r.value;
				return r.end;
			}
			case "cache_creation":
				if (b[start] !== OPEN_BRACE) {
					usage.hasSplit = false;
					usage.cacheWrite5mTokens = null;
					usage.cacheWrite1hTokens = null;
					return skipValue(b, start);
				}
				usage.hasSplit = true;
				usage.cacheWrite5mTokens = null;
				usage.cacheWrite1hTokens = null;
				return scanSplit(b, start, usage);
			default:
				return skipValue(b, start);
		}
	});
	return { usage, end };
}

function scanMessage(b: Buffer, i: number, line: ScannedLine): number {
	return scanObject(b, i, (key, start) => {
		switch (key) {
			case "id": {
				const r = readString(b, start);
				line.messageId = r.value;
				return r.end;
			}
			case "model": {
				const r = readString(b, start);
				line.model = r.value;
				return r.end;
			}
			case "usage": {
				if (b[start] !== OPEN_BRACE) {
					line.usage = null;
					return skipValue(b, start);
				}
				const r = scanUsage(b, start);
				line.usage = r.usage;
				return r.end;
			}
			default:
				return skipValue(b, start);
		}
	});
}

/** Throws MalformedLineError when the line is not one JSON object. */
export function scanUsageLine(b: Buffer): ScannedLine {
	const line: ScannedLine = {
		timestamp: null,
		requestId: null,
		messageId: null,
		model: null,
		usage: null,
	};
	const start = skipSpace(b, 0);
	const end = scanObject(b, start, (key, valueStart) => {
		switch (key) {
			case "timestamp": {
				const r = readString(b, valueStart);
				line.timestamp = r.value;
				return r.end;
			}
			case "requestId": {
				const r = readString(b, valueStart);
				line.requestId = r.value;
				return r.end;
			}
			case "message":
				if (b[valueStart] !== OPEN_BRACE) {
					line.messageId = null;
					line.model = null;
					line.usage = null;
					return skipValue(b, valueStart);
				}
				line.messageId = null;
				line.model = null;
				line.usage = null;
				return scanMessage(b, valueStart, line);
			default:
				return skipValue(b, valueStart);
		}
	});
	if (skipSpace(b, end) !== b.length) malformed();
	return line;
}
