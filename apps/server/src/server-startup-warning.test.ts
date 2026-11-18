import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { setConsoleLogging } from "@better-ccflare/logger";
import startServer from "./server";

// startServer stops at the warning hook (the spy throws), so no database,
// listener, poller or network is ever reached. If the hook call is missing,
// the backstop stops it at the next eager config read, still before any of
// those.
class StopAtWarningHook extends Error {}
class RanPastWarningHook extends Error {}

describe("startServer: ignored use_extra_usage warning", () => {
	let dir: string;
	let previousConfigPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ccflare-startup-warning-"));
		previousConfigPath = process.env.BETTER_CCFLARE_CONFIG_PATH;
		process.env.BETTER_CCFLARE_CONFIG_PATH = join(dir, "config.json");
	});

	afterEach(() => {
		if (previousConfigPath === undefined) {
			delete process.env.BETTER_CCFLARE_CONFIG_PATH;
		} else {
			process.env.BETTER_CCFLARE_CONFIG_PATH = previousConfigPath;
		}
		setConsoleLogging(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("calls the config's startup warning hook with a warning callback", async () => {
		const hook = spyOn(
			Config.prototype,
			"reportUseExtraUsageAtStartup",
		).mockImplementation(() => {
			throw new StopAtWarningHook();
		});
		const backstop = spyOn(Config.prototype, "getRuntime").mockImplementation(
			() => {
				throw new RanPastWarningHook();
			},
		);
		try {
			const started = startServer({ port: 0, withDashboard: false });
			await expect(started).rejects.toBeInstanceOf(StopAtWarningHook);
			expect(hook).toHaveBeenCalledTimes(1);
			expect(typeof hook.mock.calls[0]?.[0]).toBe("function");
		} finally {
			hook.mockRestore();
			backstop.mockRestore();
		}
	});
});
