// A command-line tool that calls the program: it copies a non-empty
// TRACEPARENT into its request's traceparent header, as
// docs/execution-events.md asks of such a tool, and prints what it got.
// With `leave` after the URL, it exits once the first chunk of the body
// arrives, and the connection closes only as its process ends.
const traceparent = process.env.TRACEPARENT ?? "";
const response = await fetch(process.argv[2], { headers: traceparent === "" ? {} : { traceparent } });
const printed = JSON.stringify({ status: response.status, traceparent });
if (process.argv[3] === "leave") {
  await response.body.getReader().read();
  process.stdout.write(printed, () => process.exit(0));
} else {
  await response.text();
  process.stdout.write(printed);
}
