/**
 * Digi-Key ProductSearch v4 pi extension.
 *
 * Registers `digikey_search` from the agent-neutral definition in lib/tool.mjs.
 * The tool is a normal direct tool and is also callable from codemode scripts
 * as `tools.digikey_search(...)`.
 *
 * The companion skill is advertised through `resources_discover`, so installing
 * this extension is enough to make the repeated-search workflow available.
 */

import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatError } from "../lib/digikey.mjs";
import {
  INPUT_SCHEMA,
  OUTPUT_SCHEMA,
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTION,
  TOOL_GUIDELINES,
  TOOL_NAME,
  TOOL_PROMPT_SNIPPET,
  TOOL_TITLE,
  runDigikeySearch,
} from "../lib/tool.mjs";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

type SearchParameters = { keywords: string; [key: string]: unknown };

const digikeySearchTool = defineTool({
  name: TOOL_NAME,
  label: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  promptSnippet: TOOL_PROMPT_SNIPPET,
  promptGuidelines: TOOL_GUIDELINES,
  exposure: "direct",
  namespace: {
    name: "digikey",
    aliases: ["dk"],
    description: "Digi-Key ProductSearch v4",
    instructions:
      "Use digikey_search in a loop: broad keyword search, read filterOptions, then re-search with IDs from that response. All filter IDs must come from Digi-Key's response.",
  },
  annotations: { ...TOOL_ANNOTATIONS },
  parameters: Type.Unsafe<SearchParameters>(INPUT_SCHEMA),
  // Declaring an output schema makes codemode resolve tool calls to the
  // structuredContent object instead of the compact text summary.
  outputSchema: Type.Unsafe(OUTPUT_SCHEMA),

  async execute(_toolCallId, params, signal) {
    try {
      const { text, result } = await runDigikeySearch(params, { signal });
      return {
        content: [{ type: "text", text }],
        details: result,
        structuredContent: result,
      };
    } catch (error) {
      throw new Error(formatError(error));
    }
  },

  renderResult(result, _options, theme) {
    const details = result.details as
      | {
          query: string;
          returnedProductCount: number;
          apiProductsCount: number;
          warnings?: string[];
        }
      | undefined;
    if (!details) {
      const first = result.content[0];
      return new Text(first?.type === "text" ? first.text : "", 0, 0);
    }
    const warningText =
      details.warnings && details.warnings.length > 0
        ? ` · ${theme.fg("muted", `${details.warnings.length} warning(s)`)}`
        : "";
    return new Text(
      theme.fg(
        "toolTitle",
        theme.bold(`Digi-Key: ${details.query}`),
      ) +
        theme.fg(
          "muted",
          ` — ${details.returnedProductCount}/${details.apiProductsCount} shown${warningText}`,
        ),
      0,
      0,
    );
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(digikeySearchTool);

  // Make the skill available whenever the extension is loaded, including when
  // it is symlinked into ~/.pi/agent/extensions by install.sh.
  pi.on("resources_discover", () => ({ skillPaths: [SKILLS_DIR] }));
}
