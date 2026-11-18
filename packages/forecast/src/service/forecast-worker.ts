import { fitPaceModel } from "../engine/pace";
import { planReplyTransfer, runPlanJob } from "../engine/plan-job";
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

/** Each job: its result, or a promise of it, and the result buffers moved back to the caller. */
const handlers: {
	[J in ForecastJobName]: {
		run: (
			payload: ForecastWorkerJobs[J]["payload"],
		) =>
			| ForecastWorkerJobs[J]["result"]
			| Promise<ForecastWorkerJobs[J]["result"]>;
		transfer?: (result: ForecastWorkerJobs[J]["result"]) => Transferable[];
	};
} = {
	refit: {
		run: ({ start, units, censored, timeZone, now }) =>
			fitPaceModel({ start, units, censored, timeZone }, now),
	},
	plan: {
		// The deadline is on this worker's clock: performance.now has a per-thread origin.
		run: ({ ctx, budgetMs }) =>
			runPlanJob(ctx, {
				deadline: performance.now() + budgetMs,
				now: () => performance.now(),
			}),
		transfer: planReplyTransfer,
	},
};

self.onmessage = async (event: MessageEvent<ForecastWorkerRequest>) => {
	const { id, job, payload } = event.data;
	let reply: ForecastWorkerReply;
	let transfer: Transferable[] = [];
	try {
		const handler = handlers[job] as
			| {
					run: (payload: unknown) => unknown;
					transfer?: (result: unknown) => Transferable[];
			  }
			| undefined;
		if (!handler) throw new TypeError("forecast-worker: unknown job");
		const result = await handler.run(payload);
		transfer = handler.transfer?.(result) ?? [];
		reply = { id, ok: true, result };
	} catch (error) {
		reply = {
			id,
			ok: false,
			error: error instanceof Error ? error.name : typeof error,
		};
	}
	self.postMessage(reply, transfer);
};
