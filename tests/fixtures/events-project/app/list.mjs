// Prints one of the program's lists, as nukadoko.program.ts's `lists`
// runs it: `node app/list.mjs <routes|flags|tables> <the world's URL>`. It asks
// the running program first, so a list read before the program answers
// fails. LIST_MODE, from the program file's env, makes the list a wrong
// one: `fail` exits 3 after a line on stderr, `malformed` prints a
// routes line with a key the format does not have, and `short` leaves the
// last route out, as a world whose program lacks it would.
const [kind, url] = process.argv.slice(2);
const answer = await fetch(new URL("/up", url));
if (!answer.ok) process.exit(4);

const ROUTES = [
  { method: "GET", route: "/up", handler: "health#show" },
  { method: "GET", route: "/rooms/:id", handler: "rooms#show" },
  { method: "PUT", route: "/rooms/:id", handler: "rooms#update" },
  { method: "PATCH", route: "/rooms/:id", handler: "rooms#update" },
  { method: "DELETE", route: "/rooms/:id", handler: "rooms#destroy" },
  { method: "POST", route: "/scores", handler: "scores#create" },
  { method: "GET", route: "/orders/:id", handler: "orders#show" },
];
const FLAGS = [
  { name: "quick_reorder", sides: ["off", "on"] },
  { name: "slider_input", sides: ["off", "on"] },
];
// What each table the server writes holds: `events` is the record a page
// keeps of each visit, and `solid_cache_entries` the cache a page fills on
// a miss. A table with no `holds` holds state.
const TABLES = [
  { table: "rooms" },
  { table: "scores", holds: "state" },
  { table: "rankings" },
  { table: "events", holds: "bookkeeping" },
  { table: "solid_cache_entries", holds: "infrastructure" },
];
const LISTS = { routes: ROUTES, flags: FLAGS, tables: TABLES };

if (process.env.LIST_MODE === "fail") {
  process.stderr.write(`the ${kind} list is not ready\n`);
  process.exit(3);
}
const lines = LISTS[kind].map((entry) => JSON.stringify(entry));
if (process.env.LIST_MODE === "short" && kind === "routes") lines.pop();
if (process.env.LIST_MODE === "malformed") lines.splice(1, 0, JSON.stringify({ method: "GET", path: "/rooms/:id" }));
process.stdout.write(`${lines.join("\n")}\n`);
