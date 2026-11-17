import type { LearnInput, PoolTau, RowScores } from "../types";
import { presentOnly } from "./present";

/** Row 2 (pool shrinkage). Stub: scores the present value only. */
export function scorePool(_input: LearnInput): RowScores<PoolTau> {
	return presentOnly("pool", "hard3" as PoolTau);
}
