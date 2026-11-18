/** Lets the event loop run (the engine computes inside the proxy process). */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Work written as a generator that yields (no value) at points where it may pause. Each step
 * between two yields is short (one trace or one sample column), so a driver can bound how long
 * the work holds the thread.
 */
export type Sliced<T> = Generator<undefined, T, undefined>;

/**
 * Work the sliced driver runs between two event-loop turns. Under the engine's design target of
 * about 25 ms per synchronous slice, with room for the step that crosses it.
 */
export const SLICE_MS = 10;

/** Runs sliced work to its end without pausing. */
export function runNow<T>(work: Sliced<T>): T {
	for (;;) {
		const step = work.next();
		if (step.done) return step.value;
	}
}

/** Runs sliced work, letting the event loop run once about every `sliceMs` of work. */
export async function runSliced<T>(
	work: Sliced<T>,
	sliceMs: number = SLICE_MS,
): Promise<T> {
	let from = performance.now();
	for (;;) {
		const step = work.next();
		if (step.done) return step.value;
		if (performance.now() - from >= sliceMs) {
			await yieldToEventLoop();
			from = performance.now();
		}
	}
}
