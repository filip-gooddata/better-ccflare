/** Hand-written pieces (sandbox lib.ts:151-184); simple-statistics has only one-variable regression. */

/** Solve (X'WX + lambda * sum(w) * I) beta = X'Wy for centred columns by Gaussian elimination. */
export function ridge(
	X: number[][],
	y: number[],
	lambda: number,
	w: number[],
): number[] {
	const p = X[0]?.length ?? 0;
	const A = Array.from({ length: p }, () => new Array<number>(p + 1).fill(0));
	let W = 0;
	for (let r = 0; r < X.length; r++) {
		const wr = w[r] as number;
		const xr = X[r] as number[];
		W += wr;
		for (let i = 0; i < p; i++) {
			const Ai = A[i] as number[];
			for (let j = 0; j < p; j++)
				Ai[j] = (Ai[j] as number) + wr * (xr[i] as number) * (xr[j] as number);
			Ai[p] = (Ai[p] as number) + wr * (xr[i] as number) * (y[r] as number);
		}
	}
	for (let i = 0; i < p; i++) {
		const Ai = A[i] as number[];
		Ai[i] = (Ai[i] as number) + lambda * W;
	}
	for (let c = 0; c < p; c++) {
		let piv = c;
		for (let r = c + 1; r < p; r++)
			if (
				Math.abs((A[r] as number[])[c] as number) >
				Math.abs((A[piv] as number[])[c] as number)
			)
				piv = r;
		const tmp = A[c] as number[];
		A[c] = A[piv] as number[];
		A[piv] = tmp;
		const Ac = A[c] as number[];
		if (Math.abs(Ac[c] as number) < 1e-12) return new Array<number>(p).fill(0);
		for (let r = 0; r < p; r++) {
			if (r === c) continue;
			const Ar = A[r] as number[];
			const f = (Ar[c] as number) / (Ac[c] as number);
			for (let k = c; k <= p; k++)
				Ar[k] = (Ar[k] as number) - f * (Ac[k] as number);
		}
	}
	return A.map((row, i) => (row[p] as number) / (row[i] as number));
}

/** Seeded RNG (mulberry32). */
export function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s |= 0;
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One-sided paired sign-flip test over independent units: H0 mean(d) <= 0. */
export function signFlipP(d: number[], iters = 4000, seed = 7): number {
	if (d.length < 2) return 1;
	let obs = 0;
	for (const x of d) obs += x;
	if (obs <= 0) return 1;
	const r = rng(seed);
	let ge = 0;
	for (let k = 0; k < iters; k++) {
		let s = 0;
		for (const x of d) s += r() < 0.5 ? -x : x;
		if (s >= obs - 1e-12) ge++;
	}
	return (ge + 1) / (iters + 1);
}

/** Benjamini-Hochberg: the indices rejected at level q. */
export function bh(ps: number[], q: number): Set<number> {
	const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
	let kmax = -1;
	idx.forEach(([p], k) => {
		if (p <= ((k + 1) / idx.length) * q) kmax = k;
	});
	return new Set(idx.slice(0, kmax + 1).map(([, i]) => i));
}
