// soz-mcp.ts — Runs the soz MCP gateway over stdio.
//   node --experimental-strip-types --disable-warning=ExperimentalWarning src/soz-mcp.ts gateway.json
// Standard output carries only MCP messages; everything else goes to standard error.

import { main } from "./gateway.ts";

const config = process.argv[2];
if (!config) {
  process.stderr.write("usage: soz-mcp gateway.json\n");
  process.exit(2);
}
main(config).catch(e => {
  process.stderr.write(`soz-gateway: ${(e as Error).message}\n`);
  process.exit(1);
});
