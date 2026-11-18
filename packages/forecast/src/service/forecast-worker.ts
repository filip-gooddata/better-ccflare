import { learnDemand, makePartitionFitter } from "../engine/learn";
import type {
	ForecastJobName,
	ForecastWorkerJobs,
	ForecastWorkerReply,
	ForecastWorkerRequest,
} from "./forecast-worker-runner";

/**
 * The forecast worker: CPU-heavy forecast jobs off the proxy's main thread.
 * Imports no database, logger or config. The CLI build bundles this module and
 * embeds it in the binary; forecast-worker-runner.ts starts it.
 */
declare const self: Worker;

const handlers: {
	[J in ForecastJobName]: (
		payload: ForecastWorkerJobs[J]["payload"],
	) => ForecastWorkerJobs[J]["result"];
} = {
	refit: ({ start, units, censored, timeZone, now, ...settings }) => {
		const series = { start, units, censored, timeZone };
		const fitWithPartition = makePartitionFitter(series, now);
		const learned = learnDemand({ ...settings, series, now, fitWithPartition });
		return { pace: fitWithPartition(learned.partition), learned };
	},
};

self.onmessage = (event: MessageEvent<ForecastWorkerRequest>) => {
	const { id, job, payload } = event.data;
	let reply: ForecastWorkerReply;
	try {
		const handler = handlers[job];
		if (!handler) throw new TypeError("forecast-worker: unknown job");
		reply = { id, ok: true, result: handler(payload) };
	} catch (error) {
		reply = {
			id,
			ok: false,
			error: error instanceof Error ? error.name : typeof error,
		};
	}
	self.postMessage(reply);
};
