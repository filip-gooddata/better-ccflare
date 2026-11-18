import { PRESENT_GROUP } from "../pace/calendar";
import type { Partition } from "./types";

/** Relabels groups by first occurrence Mon..Sun, so equal partitions compare equal. */
export function normalizePartition(p: Partition): number[] {
	const ids = new Map<number, number>();
	return p.map((g) => {
		let id = ids.get(g);
		if (id === undefined) {
			id = ids.size;
			ids.set(g, id);
		}
		return id;
	});
}

/** The normalized 7-digit string the log writes, e.g. "0111122" for the present partition. */
export const partitionKey = (p: Partition): string =>
	normalizePartition(p).join("");

/** E4's present calendar: Mon / Tue-Fri / Sat-Sun. */
export const PRESENT_PARTITION: Partition = [...PRESENT_GROUP];

export const isPresentPartition = (p: Partition): boolean =>
	partitionKey(p) === partitionKey(PRESENT_PARTITION);
