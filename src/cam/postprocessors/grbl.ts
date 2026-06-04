import { PostProcessor } from "./base";

export class Grbl extends PostProcessor {
  readonly name = "grbl";
  // No bezier override — GRBL doesn't support G5; uses base G1 flattening default.
}
