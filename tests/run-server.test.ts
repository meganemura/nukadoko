import { createServer } from "node:net";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { listenAddress, runServer } from "../src/context/run-server.js";

// Responsibility: `runServer` against real processes: it resolves once the
// URL's port accepts a connection and `stop()` ends the program; it refuses
// a port something else already holds, a program that exits first, one
// that never listens, and a missing URL. `listenAddress` reads the host and
// port a URL names.

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createServer().listen(port, "127.0.0.1");
    socket.once("listening", () => socket.close(() => resolve(false)));
    socket.once("error", () => resolve(true));
  });
}

const LISTEN = (port: number) => `require("node:http").createServer((q, s) => s.end("ok")).listen(${port}, "127.0.0.1")`;

describe("runServer", () => {
  it("resolves once the program listens, and stop() ends it", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const server = await runServer(process.execPath, ["-e", `setTimeout(() => { ${LISTEN(port)} }, 200)`], { url });
    const body = await (await fetch(url)).text();
    await server.stop();

    expect(server.url).toBe(url);
    expect(body).toBe("ok");
    expect(await accepts(port)).toBe(false);
  });

  it("refuses a port that already accepts connections, and starts nothing", async () => {
    const port = await freePort();
    const holder = createServer().listen(port, "127.0.0.1");
    await new Promise((resolve) => holder.once("listening", resolve));
    try {
      await expect(runServer(process.execPath, ["-e", LISTEN(port)], { url: `http://127.0.0.1:${port}` })).rejects.toThrow(
        `runServer did not start ${process.execPath} -e ${LISTEN(port)}: something already accepts connections at 127.0.0.1:${port}, so every request would reach a server it did not start; stop that server, or run one scenario at a time`,
      );
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("names the exit code and stderr of a program that exits before it listens", async () => {
    const port = await freePort();

    await expect(
      runServer(process.execPath, ["-e", 'console.error("no config"); process.exit(3)'], { url: `http://127.0.0.1:${port}` }),
    ).rejects.toThrow(`exited with code 3 before it accepted connections at 127.0.0.1:${port}; its stderr ends: no config`);
  });

  it("stops a program that never listens, once the timeout passes", async () => {
    const port = await freePort();

    await expect(
      runServer(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { url: `http://localhost:${port}/api`, timeout: 300 }),
    ).rejects.toThrow(
      `did not accept connections at localhost:${port} within 300 ms, so it was stopped; make it listen at http://localhost:${port}/api, or pass a longer timeout; it wrote nothing to stderr`,
    );
  });

  it("refuses a missing URL and one that is not http or https", async () => {
    await expect(runServer(process.execPath, [], { url: undefined })).rejects.toThrow(
      "runServer needs the URL the program listens at, and got none: set baseURL in the nukadoko config",
    );
    await expect(runServer(process.execPath, [], { url: "ftp://127.0.0.1:21" })).rejects.toThrow(
      'runServer needs an http or https URL, and got "ftp://127.0.0.1:21"',
    );
  });
});

describe("listenAddress", () => {
  it("reads the host and port of an http or https URL, and the protocol's port when it names none", () =>
    hegel.test((tc) => {
      const protocol = tc.draw(gs.sampledFrom(["http", "https"]));
      const [host, written] = tc.draw(gs.sampledFrom([["127.0.0.1", "127.0.0.1"], ["localhost", "localhost"], ["::1", "[::1]"], ["api.test", "api.test"]]));
      const port = tc.draw(gs.oneOf(gs.just(null), gs.integers({ minValue: 1, maxValue: 65535 })));
      const pathname = tc.draw(gs.sampledFrom(["", "/", "/v1/items?x=1"]));
      const url = `${protocol}://${written}${port === null ? "" : `:${port}`}${pathname}`;
      const defaultPort = protocol === "http" ? 80 : 443;
      expect(listenAddress(url)).toEqual({ host, port: port ?? defaultPort });
    }));

  it("refuses anything that is not an http or https URL", () => {
    expect(listenAddress("127.0.0.1:3000")).toEqual({ refusal: 'runServer needs an http or https URL, and got "127.0.0.1:3000"' });
    expect(listenAddress("file:///tmp/x")).toEqual({ refusal: 'runServer needs an http or https URL, and got "file:///tmp/x"' });
  });
});
