// What the program under test prints of its places, one JSON object per
// line, for each kind of list the program's lists name.
const lines = {
  routes: [
    { method: "POST", route: "/items", handler: "items#create" },
    { method: "POST", route: "/peek", handler: "items#peek" },
    { method: "GET", route: "/items", handler: "items#index" },
  ],
  flags: [{ name: "quick_reorder", sides: ["off", "on"] }],
  tables: [{ table: "items" }, { table: "visits", holds: "bookkeeping" }],
  "bad-tables": [{ table: "visits", holds: "bookkeeping" }, { table: "visits" }],
}[process.argv[2]];
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
