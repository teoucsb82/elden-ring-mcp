// The actual entry point for running the server (`npm run mcp`, `npm run smoke`, or an .mcp.json
// entry pointing here). mcp-server.ts only builds the server and its tools and exports `startStdio()`
// — it never starts stdio just by being imported, so tests can import it side-effect-free. This
// file's only job is to make that explicit call.
import { startStdio } from './mcp-server.js';

await startStdio();
