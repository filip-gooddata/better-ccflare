/**
 * The engine's only source of randomness: a seeded generator, so the same seed
 * always yields the same stream. The seed string is hashed with cyrb128 into the
 * 128-bit state of sfc32 (Chris Doty-Humphrey's Small Fast Counter generator,
 * from PractRand); normal variates by the Box–Muller transform.
 */
export interface Rng {
	/** Uniform in [0, 1). */
	uniform(): number;
	/** Standard normal. */
	normal(): number;
	/** Uniform integer in 0..n-1. */
	int(n: number): number;
}

/** Outputs discarded after seeding so that similar seeds decorrelate (customary for sfc32). */
const WARM_UP_ROUNDS = 15;
const TWO_POW_32 = 4_294_967_296;

/** cyrb128 string hash (bryc): four 32-bit words. */
function cyrb128(seed: string): [number, number, number, number] {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let i = 0; i < seed.length; i++) {
		const k = seed.charCodeAt(i);
		h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
	h1 ^= h2 ^ h3 ^ h4;
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRng(seed: string): Rng {
	let [a, b, c, d] = cyrb128(seed);
	const next = (): number => {
		d = (d + 1) | 0;
		const t = (((a + b) | 0) + d) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / TWO_POW_32;
	};
	for (let i = 0; i < WARM_UP_ROUNDS; i++) next();
	return {
		uniform: next,
		// Box–Muller, one variate per call from two uniforms (no cached spare, so the
		// stream depends only on the order of calls).
		normal() {
			const u1 = 1 - next();
			const u2 = next();
			return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
		},
		int(n: number) {
			return Math.floor(next() * n);
		},
	};
}
