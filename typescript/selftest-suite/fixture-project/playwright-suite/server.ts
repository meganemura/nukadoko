import { createServer, type Server } from "node:http";

// Responsibility: the tiny request-based app both e2e/cart.spec.ts and
// features/steps/lib/cart.ts talk to. Request-based, not a browser: this
// fixture only has to prove that the *implementation* is shared, and
// launching a browser here would only spend selftest time on Playwright's
// own already-tested browser plumbing.
//
// Never imported by anything under features/ or e2e/ -- it sits beside
// them so nukadoko's own discovery walk (scoped to featuresDir) and
// Playwright's own testDir walk (scoped to ./e2e) both never see it, and
// selftest-suite/features/steps/playwright-suite.ts is the only file that
// starts and stops it.
//
// Ephemeral port (`listen(0, ...)`), the same convention every server this
// repository spins up for a test already uses (see any `tests/*.test.ts`
// that opens one) -- a fixed port would make this scenario flaky if
// anything else on the machine happens to hold it.

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startServer(): Promise<RunningServer> {
  const carts = new Map<string, { id: string; items: string[] }>();

  const server: Server = createServer((req, res) => {
    const [, kind, id] = (req.url ?? "").split("/");

    if (req.method === "POST" && kind === "carts") {
      const cart = { id: `cart-${carts.size + 1}`, items: [] as string[] };
      carts.set(cart.id, cart);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cart));
      return;
    }

    if (req.method === "POST" && kind === "items" && id !== undefined) {
      const cart = carts.get(id);
      if (cart === undefined) {
        res.writeHead(404).end();
        return;
      }
      cart.items.push("x");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cartId: cart.id, count: cart.items.length }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the fixture server to bind to a TCP port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
