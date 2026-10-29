import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { createLineGroups, describeCounted, GROUP_FIELDS, groupsAdded, type CountedGroup } from "../src/execution-events/counted.js";
import { DB_OPS, EVENT_KINDS, type EventKindName, type JsonObject } from "../src/execution-events/format.js";

// Responsibility: what the lines a count counted were
// (src/execution-events/counted.ts): the lines grouped by their kind's
// group fields, the groups a later count holds more lines of, and the
// words a claim's line names them in. Grouping keeps every line in one
// group whatever order the lines come in, and what a later count adds
// is exactly the lines it was given past the earlier one's.

const TABLES = ["scores", "events", "rankings", "audit log"];

const dbLine = gs.tuples(gs.sampledFrom([...DB_OPS]), gs.sampledFrom(TABLES)).map(([op, table]): JsonObject => ({ kind: "db", op, table, rows: 1 }));

function groupsOf(objects: readonly JsonObject[], kind: EventKindName = "db"): CountedGroup[] {
  const groups = createLineGroups(kind);
  for (const object of objects) groups.add(object);
  return groups.groups();
}

const byFields = (groups: readonly CountedGroup[]): CountedGroup[] => [...groups].sort((left, right) => JSON.stringify(left.fields).localeCompare(JSON.stringify(right.fields)));

describe("createLineGroups", () => {
  it("puts every line in the one group its fields name, most lines first, whatever order the lines come in", () =>
    hegel.test((tc) => {
      const objects = tc.draw(gs.arrays(dbLine, { maxSize: 20 }));
      const shuffled = [...objects];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = tc.draw(gs.integers({ minValue: 0, maxValue: index }));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      const groups = groupsOf(objects);
      expect(groupsOf(shuffled)).toEqual(groups);
      expect(groups.reduce((total, group) => total + group.lines, 0)).toBe(objects.length);
      expect(new Set(groups.map((group) => JSON.stringify(group.fields))).size).toBe(groups.length);
      for (const [index, group] of groups.entries()) {
        expect(Object.keys(group.fields)).toEqual([...GROUP_FIELDS.db]);
        expect(group.lines).toBe(objects.filter((object) => object.op === group.fields.op && object.table === group.fields.table).length);
        if (index > 0) expect(group.lines).toBeLessThanOrEqual(groups[index - 1]!.lines);
      }
    }));

  it("counts the lines it is handed at the reading without keeping them", () => {
    const groups = createLineGroups("db");
    groups.add({ kind: "db", op: "insert", table: "events" });
    expect(groups.groups([{ kind: "db", op: "insert", table: "scores" }])).toEqual([
      { kind: "db", fields: { op: "insert", table: "events" }, lines: 1 },
      { kind: "db", fields: { op: "insert", table: "scores" }, lines: 1 },
    ]);
    expect(groups.groups()).toEqual([{ kind: "db", fields: { op: "insert", table: "events" }, lines: 1 }]);
  });

  it("tells lines apart only by fields the format requires", () => {
    for (const [kind, names] of Object.entries(GROUP_FIELDS)) {
      const fields: Readonly<Record<string, { readonly required: boolean }>> = EVENT_KINDS[kind as EventKindName];
      for (const name of names) expect([kind, name, fields[name]?.required]).toEqual([kind, name, true]);
    }
  });
});

describe("groupsAdded", () => {
  it("names, as added, exactly the lines a later count was given past an earlier one", () =>
    hegel.test((tc) => {
      const earlier = tc.draw(gs.arrays(dbLine, { maxSize: 12 }));
      const later = tc.draw(gs.arrays(dbLine, { maxSize: 12 }));
      expect(byFields(groupsAdded(groupsOf(earlier), groupsOf([...earlier, ...later])))).toEqual(byFields(groupsOf(later)));
    }));

  it("names no group a later count holds fewer lines of", () => {
    const scores = { kind: "db" as const, fields: { op: "insert", table: "scores" } };
    expect(groupsAdded([{ ...scores, lines: 2 }], [{ ...scores, lines: 1 }])).toEqual([]);
  });
});

describe("describeCounted", () => {
  const insert = (table: string): JsonObject => ({ kind: "db", op: "insert", table });

  it("names one group without its count, several with theirs, and how many lines the groups past three hold", () => {
    expect(describeCounted([])).toBe("");
    expect(describeCounted(groupsOf([insert("events")]))).toBe("1 line: db insert into events");
    expect(describeCounted(groupsOf([insert("scores"), insert("scores")]))).toBe("2 lines: db insert into scores");
    expect(describeCounted(groupsOf([insert("scores"), { kind: "db", op: "update", table: "rankings" }, insert("scores")]))).toBe(
      "3 lines: 2 db insert into scores, 1 db update rankings",
    );
    const many = [...Array.from({ length: 4 }, () => insert("scores")), insert("events"), insert("events"), insert("rankings"), insert("audit log"), insert("audits")];
    expect(describeCounted(groupsOf(many))).toBe('9 lines: 4 db insert into scores, 2 db insert into events, 1 db insert into "audit log", and 2 more lines in 2 groups');
    expect(describeCounted(groupsOf([insert("scores")]), true)).toBe("1 more line: db insert into scores");
  });

  it("names each kind's line by the work it reports", () => {
    const named = (kind: EventKindName, object: Record<string, unknown>): string => describeCounted(groupsOf([{ kind, ...object }], kind));
    expect(named("request", { method: "GET", route: "/rooms/:id", status: 200 })).toBe("1 line: request GET /rooms/:id 200");
    expect(named("request", { method: "GET", route: null, status: 404 })).toBe("1 line: request GET (no route) 404");
    expect(named("db", { op: "read", table: "rooms" })).toBe("1 line: db read from rooms");
    expect(named("db", { op: "delete", table: "sessions" })).toBe("1 line: db delete from sessions");
    expect(named("db", { op: "other", table: "unknown" })).toBe("1 line: db other on unknown");
    expect(named("tx", { id: "t1", phase: "rollback" })).toBe("1 line: tx rollback");
    expect(named("job", { name: "ScoreRecalcJob", phase: "enqueue", job_id: "j1" })).toBe("1 line: job ScoreRecalcJob enqueue");
    expect(named("http", { method: "POST", origin: "https://mail.example.com", path: "/send", status: null })).toBe("1 line: http POST https://mail.example.com (no response)");
    expect(named("flag", { name: "quick_reorder", side: "on", gate: "actor" })).toBe("1 line: flag quick_reorder on");
    expect(named("error", { class: "ActiveRecord::RecordInvalid", handled: true })).toBe("1 line: error ActiveRecord::RecordInvalid (handled)");
    expect(named("error", { class: "TypeError", handled: false })).toBe("1 line: error TypeError (not handled)");
  });
});
