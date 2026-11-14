import { createServer } from "node:http";

// `/room` fetches `/state` when it loads and on `refresh(ms)`, and draws
// the answer. `/state?hold=<ms>` answers "refreshed" after that long, so a
// Then can read the page while that answer is in flight. Any other path
// answers 200, which is how nukadoko sees the program has started.
console.log("listening");
createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  console.log(`${req.headers.traceparent ?? "-"} ${req.method} ${req.url}`);
  if (url.pathname === "/room") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<p id="state">loading</p><script>
      const draw = (query) => fetch("/state" + query).then((r) => r.text()).then((t) => { document.getElementById("state").textContent = t; });
      window.refresh = (ms) => { draw("?hold=" + ms); };
      draw("");
    </script>`);
    return;
  }
  if (url.pathname === "/state") {
    const hold = Number(url.searchParams.get("hold") ?? 0);
    setTimeout(() => res.end(hold > 0 ? "refreshed" : "ready"), hold);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
}).listen(Number(process.env.PORT));
