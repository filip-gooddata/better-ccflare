import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, USE_EXTRA_USAGE_IGNORED_WARNING } from "./index";

const ENV = "CCFLARE_USE_EXTRA_USAGE";

function makeConfig(dir = mkdtempSync(join(tmpdir(), "bcc-extra-usage-"))) {
	return {
		dir,
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getUseExtraUsage / setUseExtraUsage", () => {
	const original = process.env[ENV];

	beforeEach(() => {
		delete process.env[ENV];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[ENV];
		else process.env[ENV] = original;
	});

	it("is off by default: extra usage is billed, so spending it must be chosen", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUseExtraUsage()).toBe(false);
			expect(config.getUseExtraUsageSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("honours and persists a dashboard write", () => {
		const { dir, config, cleanup } = makeConfig();
		try {
			config.setUseExtraUsage(true);
			expect(config.getUseExtraUsage()).toBe(true);
			expect(config.getUseExtraUsageSource()).toBe("file");
			// A fresh read of the same file sees the same answer.
			expect(new Config(join(dir, "config.json")).getUseExtraUsage()).toBe(
				true,
			);
		} finally {
			cleanup();
		}
	});

	it("does not let the environment override the switch at read time", () => {
		process.env[ENV] = "true";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUseExtraUsage()).toBe(false);
			expect(config.getUseExtraUsageSource()).toBe("default");
		} finally {
			cleanup();
		}
	});
});

describe("adoptUseExtraUsageFromEnv", () => {
	const original = process.env[ENV];

	beforeEach(() => {
		delete process.env[ENV];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[ENV];
		else process.env[ENV] = original;
	});

	it("seeds an unset switch from the environment, once, and says so", () => {
		process.env[ENV] = "on";
		const { config, cleanup } = makeConfig();
		try {
			const note = config.adoptUseExtraUsageFromEnv();
			expect(note).toContain(ENV);
			expect(config.getUseExtraUsage()).toBe(true);
			expect(config.getUseExtraUsageSource()).toBe("file");
			// Already adopted: a second boot changes nothing and says nothing.
			expect(config.adoptUseExtraUsageFromEnv()).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("never overrides a choice already made in the dashboard", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUseExtraUsage(false);
			process.env[ENV] = "true";
			expect(config.adoptUseExtraUsageFromEnv()).toBeNull();
			expect(config.getUseExtraUsage()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("accepts an explicit off and ignores values it cannot read", () => {
		process.env[ENV] = "0";
		const off = makeConfig();
		try {
			expect(off.config.adoptUseExtraUsageFromEnv()).not.toBeNull();
			expect(off.config.getUseExtraUsage()).toBe(false);
			expect(off.config.getUseExtraUsageSource()).toBe("file");
		} finally {
			off.cleanup();
		}

		process.env[ENV] = "sometimes";
		const junk = makeConfig();
		try {
			expect(junk.config.adoptUseExtraUsageFromEnv()).toBeNull();
			expect(junk.config.getUseExtraUsageSource()).toBe("default");
		} finally {
			junk.cleanup();
		}
	});

	it("does nothing when the variable is absent", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.adoptUseExtraUsageFromEnv()).toBeNull();
			expect(config.getUseExtraUsageSource()).toBe("default");
		} finally {
			cleanup();
		}
	});
});

describe("use_extra_usage is accepted but ignored", () => {
	const original = process.env[ENV];

	beforeEach(() => {
		delete process.env[ENV];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[ENV];
		else process.env[ENV] = original;
	});

	function report(config: Config): string[] {
		const warnings: string[] = [];
		config.reportUseExtraUsageAtStartup((message) => warnings.push(message));
		return warnings;
	}

	it("warns once at start when the file sets it true", () => {
		const { dir, cleanup } = makeConfig();
		try {
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ use_extra_usage: true }),
			);
			const config = new Config(join(dir, "config.json"));
			expect(config.getUseExtraUsage()).toBe(true);
			expect(report(config)).toEqual([USE_EXTRA_USAGE_IGNORED_WARNING]);
			expect(USE_EXTRA_USAGE_IGNORED_WARNING).toContain("ignored");
			expect(USE_EXTRA_USAGE_IGNORED_WARNING).toContain("five-hour");
		} finally {
			cleanup();
		}
	});

	it("says nothing when the file sets it false", () => {
		const { dir, cleanup } = makeConfig();
		try {
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ use_extra_usage: false }),
			);
			const config = new Config(join(dir, "config.json"));
			expect(config.getUseExtraUsage()).toBe(false);
			expect(report(config)).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("says nothing when it is unset", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(report(config)).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("warns once when the environment seeds it true, and not when it seeds false", () => {
		process.env[ENV] = "true";
		const on = makeConfig();
		try {
			expect(report(on.config)).toEqual([USE_EXTRA_USAGE_IGNORED_WARNING]);
			expect(on.config.getUseExtraUsage()).toBe(true);
		} finally {
			on.cleanup();
		}

		process.env[ENV] = "false";
		const off = makeConfig();
		try {
			expect(report(off.config)).toEqual([]);
			expect(off.config.getUseExtraUsage()).toBe(false);
		} finally {
			off.cleanup();
		}
	});

	it("starts an old config file carrying the setting without rewriting it", () => {
		for (const value of [true, false]) {
			const { dir, cleanup } = makeConfig();
			try {
				const path = join(dir, "config.json");
				const before = `${JSON.stringify(
					{ port: 8080, use_extra_usage: value },
					null,
					2,
				)}\n`;
				writeFileSync(path, before);
				const config = new Config(path);
				report(config);
				expect(config.getUseExtraUsage()).toBe(value);
				expect(config.getUseExtraUsageSource()).toBe("file");
				expect(readFileSync(path, "utf8")).toBe(before);
			} finally {
				cleanup();
			}
		}
	});
});
