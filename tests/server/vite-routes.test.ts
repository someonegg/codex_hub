import { resolve } from "node:path";

import { createServer } from "vite";
import { expect, it } from "vitest";

it("serves diff, session and artifact pages directly while preserving queries", async () => {
  const server = await createServer({
    configFile: resolve("vite.config.ts"),
    server: { port: 0, strictPort: false, watch: null },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of [
      "/diffs/12345678-1234-1234-1234-123456789abc",
      "/sessions/12345678-1234-1234-1234-123456789abc",
      "/artifacts",
      "/",
    ]) {
      const query = "?mode=preview&tag=a%2Fb&tag=c+d";
      const response = await fetch(origin + path + query);
      expect(response.status).toBe(200);
      expect(response.url).toBe(origin + path + query);
      expect(await response.text()).toContain("/src/client/main.tsx");
    }
    expect((await fetch(origin + "/diffs/invalid")).status).toBe(404);
  } finally {
    await server.close();
  }
});
