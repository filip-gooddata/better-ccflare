/**
 * Per-test limit for a compute() test measured over bun's default 5 s once the planner searches the
 * full grid: every plan simulates the mandatory singles (now and every local quarter hour to the
 * 24 h fine horizon, plus the 5-minute marks around each peak) for each closed account over every
 * simulated day. The value is the one the real-engine service replay already carried at the base
 * revision (service/__tests__/service-replay.test.ts:211 at 49417894, `}, 120_000);`).
 */
export const FULL_GRID_TIMEOUT_MS = 120_000;
