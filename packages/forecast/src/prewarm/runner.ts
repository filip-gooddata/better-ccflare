import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AccountId,
	EpochMs,
	ForecastSettings,
	PrewarmRunner,
	PrewarmRunResult,
} from "../types";

/**
 * `--bare` takes Anthropic auth only from ANTHROPIC_API_KEY and never reads OAuth or the keychain.
 * The proxy drops the incoming key and sends the pinned account's own credential upstream.
 */
export const PREWARM_PLACEHOLDER_API_KEY = "better-ccflare-prewarm";
export const PREWARM_PROMPT = "ok";
export const PREWARM_DEFAULT_TIMEOUT_MS = 60_000;
export const PREWARM_DEFAULT_KILL_GRACE_MS = 5_000;

const INHERITED_ENV = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"];
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface PrewarmSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	stdio: ["ignore", "ignore", "ignore"];
}

export interface PrewarmChild {
	on(
		event: "exit",
		listener: (code: number | null, signal: string | null) => void,
	): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal: NodeJS.Signals): boolean;
}

export type PrewarmSpawn = (
	command: string,
	args: string[],
	options: PrewarmSpawnOptions,
) => PrewarmChild;

export interface ClaudeCliRunnerOptions {
	settings(): ForecastSettings;
	proxyPort: number;
	/** The proxy's own API key, when the proxy requires one from local clients. */
	proxyApiKey?: () => string | null;
	spawn: PrewarmSpawn;
	makeEmptyDir(): Promise<string>;
	removeDir(path: string): Promise<void>;
	isExecutable(path: string): boolean;
	/** Environment of the proxy process; only HOME, PATH, USER, LOGNAME, TMPDIR and LANG are passed on. */
	baseEnv: Record<string, string | undefined>;
	now(): EpochMs;
	timers: {
		set(callback: () => void, delayMs: number): unknown;
		clear(handle: unknown): void;
	};
	timeoutMs?: number;
	killGraceMs?: number;
}

function errorCode(error: unknown) {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "failed";
}

export function prewarmClaudeCandidates(
	baseEnv: Record<string, string | undefined>,
): string[] {
	const home = baseEnv.HOME;
	const onPath = (baseEnv.PATH ?? "")
		.split(":")
		.filter((dir) => dir.startsWith("/"))
		.map((dir) => `${dir.replace(/\/+$/, "")}/claude`);
	const usual = [
		...(home
			? [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`]
			: []),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	];
	return [...new Set([...onPath, ...usual])];
}

export function createClaudeCliRunner(
	options: ClaudeCliRunnerOptions,
): PrewarmRunner {
	const timeoutMs = options.timeoutMs ?? PREWARM_DEFAULT_TIMEOUT_MS;
	const killGraceMs = options.killGraceMs ?? PREWARM_DEFAULT_KILL_GRACE_MS;
	const failed = (error: string): PrewarmRunResult => ({
		exitCode: null,
		durationMs: 0,
		error,
	});

	const resolveClaude = (
		settings: ForecastSettings,
	): { path: string } | { error: string } => {
		if (settings.claudePath !== null)
			return options.isExecutable(settings.claudePath)
				? { path: settings.claudePath }
				: { error: `claude not executable: ${settings.claudePath}` };
		const path = prewarmClaudeCandidates(options.baseEnv).find(
			options.isExecutable,
		);
		return path ? { path } : { error: "claude not found" };
	};

	const environment = (accountId: AccountId) => {
		const env: Record<string, string> = {};
		for (const key of INHERITED_ENV) {
			const value = options.baseEnv[key];
			if (value !== undefined) env[key] = value;
		}
		env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${options.proxyPort}`;
		env.ANTHROPIC_CUSTOM_HEADERS = `x-better-ccflare-account-id: ${accountId}`;
		env.ANTHROPIC_API_KEY =
			options.proxyApiKey?.() ?? PREWARM_PLACEHOLDER_API_KEY;
		env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
		env.DISABLE_AUTOUPDATER = "1";
		env.DISABLE_TELEMETRY = "1";
		return env;
	};

	return {
		async run(accountId) {
			if (!ACCOUNT_ID.test(accountId)) return failed("invalid account id");
			const settings = options.settings();
			const claude = resolveClaude(settings);
			if ("error" in claude) return failed(claude.error);
			const args = [
				"--print",
				PREWARM_PROMPT,
				"--bare",
				"--model",
				settings.prewarmModel,
				"--no-session-persistence",
				"--output-format",
				"text",
				// Variadic: kept last so it cannot swallow the prompt.
				"--tools",
				"",
			];
			let cwd: string;
			try {
				cwd = await options.makeEmptyDir();
			} catch (error) {
				return failed(`workdir ${errorCode(error)}`);
			}
			const started = options.now();
			try {
				return await new Promise<PrewarmRunResult>((resolve) => {
					let timedOut = false;
					let killTimer: unknown = null;
					let finished = false;
					const finish = (exitCode: number | null, error: string | null) => {
						if (finished) return;
						finished = true;
						options.timers.clear(timeoutTimer);
						if (killTimer !== null) options.timers.clear(killTimer);
						resolve({
							exitCode,
							durationMs: options.now() - started,
							error: timedOut ? `timeout after ${timeoutMs} ms` : error,
						});
					};
					let child: PrewarmChild;
					try {
						child = options.spawn(claude.path, args, {
							cwd,
							env: environment(accountId),
							stdio: ["ignore", "ignore", "ignore"],
						});
					} catch (error) {
						resolve(failed(`spawn ${errorCode(error)}`));
						return;
					}
					const timeoutTimer = options.timers.set(() => {
						timedOut = true;
						child.kill("SIGTERM");
						killTimer = options.timers.set(
							() => child.kill("SIGKILL"),
							killGraceMs,
						);
					}, timeoutMs);
					child.on("exit", (code) => finish(code, null));
					child.on("error", (error) =>
						finish(null, `spawn ${errorCode(error)}`),
					);
				});
			} finally {
				await options.removeDir(cwd).catch(() => undefined);
			}
		},
	};
}

/** The real process, file system and clock for the runner; WIRING passes these. Never used in tests. */
export function nodeClaudeCliIo(): Pick<
	ClaudeCliRunnerOptions,
	| "spawn"
	| "makeEmptyDir"
	| "removeDir"
	| "isExecutable"
	| "baseEnv"
	| "now"
	| "timers"
> {
	return {
		spawn: (command, args, spawnOptions) =>
			nodeSpawn(command, args, spawnOptions),
		makeEmptyDir: () => mkdtemp(join(tmpdir(), "ccflare-prewarm-")),
		removeDir: (path) => rm(path, { recursive: true, force: true }),
		isExecutable: (path) => {
			try {
				accessSync(path, constants.X_OK);
				return statSync(path).isFile();
			} catch {
				return false;
			}
		},
		baseEnv: process.env,
		now: () => Date.now(),
		timers: {
			set: (callback, delayMs) => setTimeout(callback, delayMs),
			clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
	};
}
