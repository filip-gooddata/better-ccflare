import { describe, expect, test } from "bun:test";
import { measureYield } from "./fixtures-sim";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function spin(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {}
}

describe("measureYield", () => {
	test("a slice that holds the CPU shows in its CPU time", async () => {
		const { longestMs, longestCpuMs } = await measureYield(async () => {
			await turn();
			spin(80);
			await turn();
		});
		console.info(
			`[measureYield] busy slice: wall ${longestMs.toFixed(1)} ms cpu ${longestCpuMs.toFixed(1)} ms`,
		);
		expect(longestCpuMs).toBeGreaterThan(60);
	});

	test("a slice the thread spends blocked shows in wall time only", async () => {
		const { longestMs, longestCpuMs } = await measureYield(async () => {
			await turn();
			Bun.sleepSync(80);
			await turn();
		});
		console.info(
			`[measureYield] blocked slice: wall ${longestMs.toFixed(1)} ms cpu ${longestCpuMs.toFixed(1)} ms`,
		);
		expect(longestMs).toBeGreaterThan(70);
		expect(longestCpuMs).toBeLessThan(20);
	});
});
