#!/usr/bin/env node
/**
 * Digi-Key ProductSearch v4 MCP server (stdio).
 *
 * Exposes `digikey_search` from lib/tool.mjs to any MCP client, such as Claude
 * Code through this repository's plugin manifest.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatError } from "../lib/digikey.mjs";
import {
  INPUT_SCHEMA,
  OUTPUT_SCHEMA,
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTION,
  TOOL_GUIDELINES,
  TOOL_NAME,
  TOOL_TITLE,
  runDigikeySearch,
} from "../lib/tool.mjs";

const SERVER_INFO = { name: "digikey", version: "0.1.0" };

const TOOL = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: `${TOOL_DESCRIPTION}\n\n${TOOL_GUIDELINES.map((line) => `- ${line}`).join("\n")}`,
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: { title: TOOL_TITLE, ...TOOL_ANNOTATIONS },
};

/**
 * Build an MCP server with `digikey_search` registered.
 *
 * @param {{fetchImpl?: Function, env?: object}} [options] Passed to the search, for tests.
 * @returns {Server} An unconnected server.
 */
export function createServer(options = {}) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    try {
      const { text, result } = await runDigikeySearch(request.params.arguments ?? {}, {
        ...options,
        signal: extra.signal,
      });
      return { content: [{ type: "text", text }], structuredContent: result };
    } catch (error) {
      return { content: [{ type: "text", text: formatError(error) }], isError: true };
    }
  });

  return server;
}

// The `digikey-search-mcp` bin is a symlink, so compare resolved paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createServer().connect(new StdioServerTransport());
}
