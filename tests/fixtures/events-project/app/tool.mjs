// A command-line tool that calls the program: it copies a non-empty
// TRACEPARENT into its request's traceparent header, as
// docs/execution-events.md asks of such a tool, and prints what it got.
const traceparent = process.env.TRACEPARENT ?? "";
const response = await fetch(process.argv[2], { headers: traceparent === "" ? {} : { traceparent } });
await response.text();
process.stdout.write(JSON.stringify({ status: response.status, traceparent }));
