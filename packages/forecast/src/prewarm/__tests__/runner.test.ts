import { describe, expect, test } from "bun:test";
import {
	type ClaudeCliRunnerOptions,
	createClaudeCliRunner,
	PREWARM_PLACEHOLDER_API_KEY,
	type PrewarmChild,
	type PrewarmSpawnOptions,
} from "../runner";
import { settings } from "./fakes";

interface SpawnCall {
	command: string;
	args: string[];
	options: PrewarmSpawnOptions;
}

class FakeChild implements PrewarmChild {
	private listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
	kills: string[] = [];
	on(event: "exit" | "error", listener: (...a: never[]) => void) {
		const list = this.listeners[event] ?? [];
		list.push(listener as (...a: unknown[]) => void);
		this.listeners[event] = list;
		return this;
	}
	kill(signal: NodeJS.Signals) {
		this.kills.push(signal);
		return true;
	}
	emit(event: "exit" | "error", ...args: unknown[]) {
		for (const l of this.listeners[event] ?? []) l(...args);
	}
}

class FakeTimers {
	pending: { fn: () => void; ms: number; id: number }[] = [];
	private n = 1;
	set = (fn: () => void, ms: number) => {
		const id = this.n++;
		this.pending.push({ fn, ms, id });
		return id;
	};
	clear = (id: unknown) => {
		this.pending = this.pending.filter((p) => p.id !== id);
	};
	fireNext() {
		const p = this.pending.shift();
		p?.fn();
	}
}

function setup(over: Partial<ClaudeCliRunnerOptions> = {}) {
	const calls: SpawnCall[] = [];
	const children: FakeChild[] = [];
	const removed: string[] = [];
	const timers = new FakeTimers();
	let now = 1_000;
	const executables = new Set(["/Users/u/.local/bin/claude"]);
	const options: ClaudeCliRunnerOptions = {
		settings: () => settings({ prewarmModel: "haiku" }),
		proxyPort: 8791,
		spawn: (command, args, opts) => {
			calls.push({ command, args, options: opts });
			const child = new FakeChild();
			children.push(child);
			return child;
		},
		makeEmptyDir: async () => "/tmp/ccflare-prewarm-x1",
		removeDir: async (path) => {
			removed.push(path);
		},
		isExecutable: (path) => executables.has(path),
		baseEnv: {
			HOME: "/Users/u",
			PATH: "/usr/bin:/bin",
			USER: "u",
			TMPDIR: "/var/folders/t/",
			LANG: "en_US.UTF-8",
			ANTHROPIC_API_KEY: "real-key-must-not-leak",
			ANTHROPIC_AUTH_TOKEN: "real-token-must-not-leak",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth-must-not-leak",
			ANTHROPIC_BASE_URL: "https://example.invalid",
			SECRET_THING: "nope",
		},
		now: () => now,
		timers,
		timeoutMs: 60_000,
		killGraceMs: 5_000,
		...over,
	};
	const runner = createClaudeCliRunner(options);
	const tick = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	return {
		runner,
		calls,
		children,
		removed,
		timers,
		executables,
		tick,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("claude CLI runner", () => {
	test("spawns the CLI once with print mode, one word, the model, no tools, no persistence", async () => {
		const t = setup();
		const done = t.runner.run("acct-123");
		await t.tick();
		expect(t.calls).toHaveLength(1);
		const call = t.calls[0];
		expect(call?.command).toBe("/Users/u/.local/bin/claude");
		expect(call?.args).toEqual([
			"--print",
			"ok",
			"--bare",
			"--model",
			"haiku",
			"--no-session-persistence",
			"--output-format",
			"text",
			"--tools",
			"",
		]);
		expect(call?.options.cwd).toBe("/tmp/ccflare-prewarm-x1");
		expect(call?.options.stdio).toEqual(["ignore", "ignore", "ignore"]);
		t.advance(2_345);
		t.children[0]?.emit("exit", 0, null);
		expect(await done).toEqual({ exitCode: 0, durationMs: 2_345, error: null });
		expect(t.removed).toEqual(["/tmp/ccflare-prewarm-x1"]);
		expect(t.timers.pending).toEqual([]);
	});

	test("environment: proxy URL, pin header, placeholder key, nothing inherited beyond the basics", async () => {
		const t = setup();
		const done = t.runner.run("acct-123");
		await t.tick();
		expect(t.calls[0]?.options.env).toEqual({
			HOME: "/Users/u",
			PATH: "/usr/bin:/bin",
			USER: "u",
			TMPDIR: "/var/folders/t/",
			LANG: "en_US.UTF-8",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:8791",
			ANTHROPIC_CUSTOM_HEADERS: "x-better-ccflare-account-id: acct-123",
			ANTHROPIC_API_KEY: PREWARM_PLACEHOLDER_API_KEY,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_AUTOUPDATER: "1",
			DISABLE_TELEMETRY: "1",
		});
		t.children[0]?.emit("exit", 0, null);
		await done;
	});

	test("a proxy API key, when given, replaces the placeholder", async () => {
		const t = setup({ proxyApiKey: () => "proxy-key" });
		const done = t.runner.run("a");
		await t.tick();
		expect(t.calls[0]?.options.env.ANTHROPIC_API_KEY).toBe("proxy-key");
		t.children[0]?.emit("exit", 0, null);
		await done;
	});

	test("the model comes from settings.prewarmModel at run time", async () => {
		let model = "haiku";
		const t = setup({ settings: () => settings({ prewarmModel: model }) });
		model = "claude-haiku-5-5";
		const done = t.runner.run("a");
		await t.tick();
		expect(t.calls[0]?.args.slice(3, 5)).toEqual([
			"--model",
			"claude-haiku-5-5",
		]);
		t.children[0]?.emit("exit", 0, null);
		await done;
	});

	test("claudePath setting first, then PATH, then the usual install places", async () => {
		const configured = setup({
			settings: () => settings({ claudePath: "/opt/custom/claude" }),
		});
		configured.executables.add("/opt/custom/claude");
		const a = configured.runner.run("a");
		await configured.tick();
		expect(configured.calls[0]?.command).toBe("/opt/custom/claude");
		configured.children[0]?.emit("exit", 0, null);
		await a;

		const onPath = setup();
		onPath.executables.add("/bin/claude");
		const b = onPath.runner.run("a");
		await onPath.tick();
		expect(onPath.calls[0]?.command).toBe("/bin/claude");
		onPath.children[0]?.emit("exit", 0, null);
		await b;
	});

	test("a configured claudePath that is not executable is an error, not a fallback", async () => {
		const t = setup({
			settings: () => settings({ claudePath: "/nope/claude" }),
		});
		expect(await t.runner.run("a")).toEqual({
			exitCode: null,
			durationMs: 0,
			error: "claude not executable: /nope/claude",
		});
		expect(t.calls).toEqual([]);
	});

	test("no claude anywhere: error without spawning", async () => {
		const t = setup();
		t.executables.clear();
		expect(await t.runner.run("a")).toEqual({
			exitCode: null,
			durationMs: 0,
			error: "claude not found",
		});
		expect(t.calls).toEqual([]);
	});

	test("an account id that cannot be a header value is refused", async () => {
		const t = setup();
		const result = await t.runner.run("a\r\nx-evil: 1");
		expect(result.error).toBe("invalid account id");
		expect(t.calls).toEqual([]);
	});

	test("timeout: SIGTERM, then SIGKILL after the grace period", async () => {
		const t = setup();
		const done = t.runner.run("a");
		await t.tick();
		expect(t.timers.pending.map((p) => p.ms)).toEqual([60_000]);
		t.advance(60_000);
		t.timers.fireNext();
		expect(t.children[0]?.kills).toEqual(["SIGTERM"]);
		expect(t.timers.pending.map((p) => p.ms)).toEqual([5_000]);
		t.timers.fireNext();
		expect(t.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
		t.children[0]?.emit("exit", null, "SIGKILL");
		expect(await done).toEqual({
			exitCode: null,
			durationMs: 60_000,
			error: "timeout after 60000 ms",
		});
		expect(t.removed).toEqual(["/tmp/ccflare-prewarm-x1"]);
	});

	test("a spawn error is reported by its code only", async () => {
		const t = setup();
		const done = t.runner.run("a");
		await t.tick();
		t.children[0]?.emit(
			"error",
			Object.assign(new Error("spawn /x ENOENT with details"), {
				code: "ENOENT",
			}),
		);
		expect(await done).toEqual({
			exitCode: null,
			durationMs: 0,
			error: "spawn ENOENT",
		});
	});

	test("a throwing spawn is caught", async () => {
		const t = setup({
			spawn: () => {
				throw Object.assign(new Error("boom"), { code: "EACCES" });
			},
		});
		expect((await t.runner.run("a")).error).toBe("spawn EACCES");
	});

	test("a non-zero exit is kept as the exit code", async () => {
		const t = setup();
		const done = t.runner.run("a");
		await t.tick();
		t.children[0]?.emit("exit", 1, null);
		expect(await done).toEqual({ exitCode: 1, durationMs: 0, error: null });
	});

	test("no output is kept: stdio is ignored and the result has only exit, duration, error", async () => {
		const t = setup();
		const done = t.runner.run("a");
		await t.tick();
		t.children[0]?.emit("exit", 0, null);
		const result = await done;
		expect(Object.keys(result).sort()).toEqual([
			"durationMs",
			"error",
			"exitCode",
		]);
		expect(t.calls[0]?.options.stdio).toEqual(["ignore", "ignore", "ignore"]);
	});
});
