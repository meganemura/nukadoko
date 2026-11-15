// The nuka processes a scenario started and did not wait for, by the
// project they run in: one at a time per project, which is all a walk
// allows.
import type { Ran } from "./engine.ts";

export const started = new Map<string, Promise<Ran>>();
