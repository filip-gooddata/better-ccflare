import type {
	ForecastWorkerReply,
	ForecastWorkerRequest,
} from "../../forecast-worker-runner";

/**
 * A stand-in for forecast-worker.ts. The refit's timeZone picks the behaviour:
 * "busy:<ms>" spins the CPU for <ms> then fits, "throw" fails the job,
 * "hang" spins forever, anything else fits at once.
 */
declare const self: Worker;

const spin = (ms: number) => {
	const end = performance.now() + ms;
	let x = 0;
	while (performance.now() < end) x += Math.sqrt(x + 1);
	return x;
};

self.onmessage = (event: MessageEvent<ForecastWorkerRequest>) => {
	const { id, job, payload } = event.data;
	let reply: ForecastWorkerReply;
	try {
		if (job !== "refit") throw new TypeError("unknown job");
		const mode = payload.timeZone;
		if (mode === "throw") throw new RangeError("fit failed");
		if (mode === "hang") for (;;) spin(1_000);
		if (mode.startsWith("busy:")) spin(Number(mode.slice(5)));
		reply = {
			id,
			ok: true,
			result: {
				fittedAt: payload.now,
				days: payload.units.length,
				weeks: payload.censored.length,
				candidates: 101,
				floor: 10,
				cellsEstablished: 0,
				cellsTotal: 0,
				belowFloor: [],
				baseline: { workday: [], monday: [], weekend: [] },
				bands: [],
				selected: [],
				dayTypeComparison: [],
			},
		};
	} catch (error) {
		reply = {
			id,
			ok: false,
			error: error instanceof Error ? error.name : typeof error,
		};
	}
	self.postMessage(reply);
};
