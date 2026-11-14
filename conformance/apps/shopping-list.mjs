// A page that keeps a list in memory: the form posts to /items, and the
// script draws the list from GET /items, so a browser step's requests are
// visible to whatever records them.
import http from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const items = [];
const page = `<!doctype html><title>List</title>
<form id="add"><input id="name" aria-label="Name"><button>Add</button></form>
<ul id="items"></ul>
<script>
async function draw() {
  const list = await (await fetch("/items")).json();
  document.querySelector("#items").replaceChildren(...list.map((name) => Object.assign(document.createElement("li"), { textContent: name })));
}
document.querySelector("#add").addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetch("/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: document.querySelector("#name").value }) });
  document.querySelector("#name").value = "";
  await draw();
});
draw();
</script>`;

http
  .createServer(async (req, res) => {
    if (req.url === "/items" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      items.push(JSON.parse(body).name);
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
    } else if (req.url === "/items") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(items));
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  })
  .listen(port, "127.0.0.1");
