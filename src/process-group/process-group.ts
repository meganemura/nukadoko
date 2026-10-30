import { readdirSync, readFileSync } from "node:fs";

// Responsibility: tell whether a POSIX process group still has a running
// member, so a world's stop gives the whole group its grace period after
// SIGTERM instead of killing it the moment the leader exits, and a step's
// `runCommand` process can say whether it left anything running.
// Boundary: signalling a group, and when to, is its owner's
// (src/program/world.ts, src/context/run-command.ts).
//
// `kill(-pgid, 0)` answers for every member, a zombie included: a member
// that exited and that no parent has reaped yet. Under a PID 1 that never
// reaps orphans, as in many containers, a server a shell started stays a
// zombie in the group once it exits, and the probe alone would wait out
// the whole grace period for a group that is already gone. On Linux,
// /proc tells a zombie apart; elsewhere the probe is the answer.
//
// A member that is exiting is not running either. The kernel closes an
// exiting process's files before it turns it into a zombie, so a pipe the
// group shared reaches its end, and `runCommand` asks, while that member
// still shows its old state: under load the test of a signalled group read
// "running" once in a full suite. The member's flags carry PF_EXITING from
// the start of its exit, before its files close, and it runs no code of its
// own after that.

// The kernel's PF_EXITING bit in the `flags` field of /proc/<pid>/stat.
const PF_EXITING = 0x4;

/** A process's state, process group, and whether it has begun to exit,
 * from the text of its `/proc/<pid>/stat`, or `undefined` when the text is
 * not one. */
export function parseProcStat(text: string): { readonly state: string; readonly pgrp: number; readonly exiting: boolean } | undefined {
  // `pid (comm) state ppid pgrp ...`: `comm` is the executable's name and
  // can hold spaces and parentheses itself, so the fields after it count
  // from the last `)`.
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  const flags = Number(fields[6]);
  if (state === undefined || state === "" || !Number.isInteger(pgrp) || !Number.isInteger(flags)) return undefined;
  return { state, pgrp, exiting: (flags & PF_EXITING) !== 0 };
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
    if (stat !== undefined && stat.pgrp === pgid && stat.state !== "Z" && stat.state !== "X" && !stat.exiting) return true;
  }
  return false;
}
