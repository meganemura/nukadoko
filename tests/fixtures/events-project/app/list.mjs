// Prints one of the program's lists, as nukadoko.program.ts's `lists`
// runs it: `node app/list.mjs <routes|flags> <the world's URL>`. It asks
// the running program first, so a list read before the program answers
// fails. LIST_MODE, from the program file's env, makes the list a wrong
// one: `fail` exits 3 after a line on stderr, and `malformed` prints a
// routes line with a key the format does not have.
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

if (process.env.LIST_MODE === "fail") {
  process.stderr.write(`the ${kind} list is not ready\n`);
  process.exit(3);
}
const lines = (kind === "routes" ? ROUTES : FLAGS).map((entry) => JSON.stringify(entry));
if (process.env.LIST_MODE === "malformed") lines.splice(1, 0, JSON.stringify({ method: "GET", path: "/rooms/:id" }));
process.stdout.write(`${lines.join("\n")}\n`);
