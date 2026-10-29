import { fileURLToPath } from "node:url";
import { runCommand } from "../nukadoko-shim.js";

const tool = fileURLToPath(new URL("./tool.mjs", import.meta.url));

/** Runs app/tool.mjs against `url` with the step's env spread from
 * process.env, as a real step passes a tool its own variables, and
 * `extra` on top. `leave` makes the tool exit after the body's first
 * chunk. */
export async function runTool(url: string, extra: Record<string, string>, leave = false): Promise<{ status: number; traceparent: string }> {
  const result = await runCommand(process.execPath, [tool, url, ...(leave ? ["leave"] : [])], { env: { ...process.env, APP_TOKEN: "unused", ...extra } });
  return JSON.parse(result.stdout) as { status: number; traceparent: string };
}
