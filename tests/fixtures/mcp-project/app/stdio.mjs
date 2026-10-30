import { createInterface } from "node:readline";
import { answer } from "./notes.mjs";

// An MCP server over stdio, one JSON-RPC message per line. It keeps no
// notes of its own: `add_note` posts to the world at WORLD_URL, carrying
// the traceparent the call brought in `params._meta`, so the world's lines
// for that request are the calling step's.
const world = process.env.WORLD_URL;

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const message = JSON.parse(line);
  const traceparent = message.params?._meta?.traceparent;
  const reply = await answer(message, async (args) => {
    const response = await fetch(new URL("/notes", world), {
      method: "POST",
      headers: { "content-type": "application/json", ...(traceparent === undefined ? {} : { traceparent }) },
      body: JSON.stringify(args),
    });
    return response.json();
  });
  if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
}
