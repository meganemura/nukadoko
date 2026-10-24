import { readdirSync, readFileSync } from "node:fs";

// Responsibility: tell whether a POSIX process group still has a running
// member, so a world's stop gives the whole group its grace period after
// SIGTERM instead of killing it the moment the leader exits. Boundary:
// signalling the group, and when to, is src/program/world.ts's.
//
// `kill(-pgid, 0)` answers for every member, a zombie included: a member
// that exited and that no parent has reaped yet. Under a PID 1 that never
// reaps orphans, as in many containers, a server a shell started stays a
// zombie in the group once it exits, and the probe alone would wait out
// the whole grace period for a group that is already gone. On Linux,
// /proc tells a zombie apart; elsewhere the probe is the answer.

/** A process's state and process group, from the text of its
 * `/proc/<pid>/stat`, or `undefined` when the text is not one. */
export function parseProcStat(text: string): { readonly state: string; readonly pgrp: number } | undefined {
  // `pid (comm) state ppid pgrp ...`: `comm` is the executable's name and
  // can hold spaces and parentheses itself, so the fields after it count
  // from the last `)`.
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  if (state === undefined || state === "" || !Number.isInteger(pgrp)) return undefined;
  return { state, pgrp };
}

/** Whether a process of group `pgid` is still running (module header). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    // EPERM: a member lives that this process may not signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let text: string;
    try {
      text = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      // Exited between the listing and the read.
      continue;
    }
    const stat = parseProcStat(text);
    if (stat !== undefined && stat.pgrp === pgid && stat.state !== "Z" && stat.state !== "X") return true;
  }
  return false;
}
