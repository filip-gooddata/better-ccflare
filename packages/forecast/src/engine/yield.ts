/** Lets the event loop run (the engine computes inside the proxy process). */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
