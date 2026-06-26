/**
 * Registry of laser/fixed-Z post-processors. Each head is a separate file in this
 * folder; to add one, create it and add it to {@link LASER_POSTS} below — the
 * generator and the machine-settings UI pick it up automatically.
 */
import type { LaserPost } from "./base";
import { GRBL_DYNAMIC } from "./grblDynamic";
import { GRBL_CONSTANT } from "./grblConstant";
import { MARLIN } from "./marlin";
import { SMOOTHIE } from "./smoothie";
import { LINUXCNC_LASER } from "./linuxcnc";

export type { LaserPost } from "./base";

/** All selectable laser post-processors, in dropdown order. */
export const LASER_POSTS: readonly LaserPost[] = [
  GRBL_DYNAMIC,
  GRBL_CONSTANT,
  MARLIN,
  SMOOTHIE,
  LINUXCNC_LASER,
];

/** The default head for a new laser project (most common; recommended). */
export const DEFAULT_LASER_POST = GRBL_DYNAMIC;

const BY_ID = new Map(LASER_POSTS.map((p) => [p.id, p]));

/**
 * Resolve a stored `postProcessor` id to a laser head. Falls back to the default
 * for unknown ids and for legacy/mill values — early laser projects shipped with
 * `postProcessor: "grbl"`, which maps to the GRBL dynamic head.
 */
export function getLaserPost(id: string | undefined): LaserPost {
  if (id && BY_ID.has(id)) return BY_ID.get(id)!;
  if (id === "grbl") return GRBL_DYNAMIC; // legacy laser docs
  return DEFAULT_LASER_POST;
}

/** `[id, name]` pairs for building a controller dropdown. */
export function laserPostOptions(): [string, string][] {
  return LASER_POSTS.map((p) => [p.id, p.name]);
}
