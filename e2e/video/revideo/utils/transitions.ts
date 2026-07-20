// Smooth cross-fades + scene fade helpers.

import { all, easeInOutCubic, easeOutCubic } from "@revideo/core";
import type { Node } from "@revideo/2d";

/** Fade a set of refs in from 0 to 1 over `durSec`. */
export function fadeIn(refs: Node[], durSec = 0.4) {
  return all(...refs.map((r) => r.opacity(1, durSec, easeOutCubic)));
}

/** Fade a set of refs out to 0 over `durSec`. */
export function fadeOut(refs: Node[], durSec = 0.35) {
  return all(...refs.map((r) => r.opacity(0, durSec, easeOutCubic)));
}

/** Cross-fade `prev` out and `next` in over `durSec`. */
export function crossFade(prev: Node[], next: Node[], durSec = 0.4) {
  return all(
    ...prev.map((r) => r.opacity(0, durSec, easeInOutCubic)),
    ...next.map((r) => r.opacity(1, durSec, easeInOutCubic)),
  );
}
