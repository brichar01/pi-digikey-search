/**
 * Digi-Key ProductSearch v4 pi extension.
 *
 * Registers `digikey_search`, which wraps the shared client in lib/digikey.mjs.
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
import { formatError, formatSearchText, searchKeyword } from "../lib/digikey.mjs";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const DEFAULT_MOQ_WARN_THRESHOLD = 10;

const SortField = Type.Union(
  [
    Type.Literal("None"),
    Type.Literal("Packaging"),
    Type.Literal("ProductStatus"),
    Type.Literal("DigiKeyProductNumber"),
    Type.Literal("ManufacturerProductNumber"),
    Type.Literal("Manufacturer"),
    Type.Literal("MinimumQuantity"),
    Type.Literal("QuantityAvailable"),
    Type.Literal("Price"),
    Type.Literal("Supplier"),
    Type.Literal("PriceManufacturerStandardPackage"),
  ],
  { description: "Sort field. Use QuantityAvailable for high-availability requests and Price for cost-focused requests." },
);

const DigiKeySearchParameters = Type.Object({
  keywords: Type.String({
    minLength: 1,
    maxLength: 250,
    description:
      "Digi-Key keyword search string (max 250 chars). Start broad (e.g. 'audio codec', 'ceramic capacitor'), then refine using filterOptions IDs returned by the first search.",
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      default: 10,
      description: "Number of products to return (1-50, default 10).",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 0,
      description: "Pagination offset.",
    }),
  ),
  manufacturerIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Manufacturer filter IDs from filterOptions.manufacturers[].id in a previous response. Do not invent IDs.",
    }),
  ),
  statusIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Product status filter IDs from filterOptions.status[].id. Obsolete/EOL parts are already removed locally; use this to prefer Active or inspect NRND status IDs.",
    }),
  ),
  categoryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Category filter IDs from filterOptions.topCategories[].category.categoryId.",
    }),
  ),
  packagingIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Packaging filter IDs from filterOptions.packaging[].id.",
    }),
  ),
  seriesIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Series filter IDs from filterOptions.series[].id.",
    }),
  ),
  parameters: Type.Optional(
    Type.Array(
      Type.Object({
        parameterId: Type.Integer({
          description: "ParameterId from filterOptions.parameters[].parameterId.",
        }),
        valueIds: Type.Array(Type.String(), {
          minItems: 1,
          description: "ValueId(s) from filterOptions.parameters[].values[].valueId.",
        }),
      }),
      {
        description:
          "Parametric filters. Only use parameterId/valueId pairs returned in filterOptions by the previous search.",
      },
    ),
  ),
  parameterCategoryId: Type.Optional(
    Type.Union([Type.String(), Type.Integer()], {
      description:
        "Category ID for ParameterFilterRequest.CategoryFilter. Usually the selected category ID. Required by some parametric filter requests.",
    }),
  ),
  minQuantityAvailable: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 1,
      description:
        "Minimum quantity available. Use a larger value for 'high availability' (e.g. 100) and sort by QuantityAvailable.",
    }),
  ),
  maxMoq: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Optional hard local filter: drop parts whose minimum order quantity exceeds this value. Omit to keep all and rely on MOQ warnings.",
    }),
  ),
  moqWarnThreshold: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: DEFAULT_MOQ_WARN_THRESHOLD,
      description: "Call out MOQ values above this threshold (default 10).",
    }),
  ),
  sortField: Type.Optional(SortField),
  sortOrder: Type.Optional(
    Type.Union([Type.Literal("Ascending"), Type.Literal("Descending")], {
      default: "Descending",
    }),
  ),
  site: Type.Optional(
    Type.String({ description: "Locale site code, e.g. US, UK, DE. Defaults to DIGIKEY_SITE or US." }),
  ),
  language: Type.Optional(
    Type.String({ description: "Locale language code, e.g. en. Defaults to DIGIKEY_LANGUAGE or en." }),
  ),
  currency: Type.Optional(
    Type.String({ description: "Currency code, e.g. USD. Defaults to DIGIKEY_CURRENCY or USD." }),
  ),
  maxFilterParameters: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 60,
      description:
        "Model-facing text limit for parametric filter groups (0 = all). The full set is always in structuredContent for codemode.",
    }),
  ),
  filterValuesPerParameter: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 20,
      description:
        "Model-facing text limit for values per parametric filter (0 = all). The full set is always in structuredContent for codemode.",
    }),
  ),
  detail: Type.Optional(
    Type.Union([Type.Literal("compact"), Type.Literal("full")], {
      default: "compact",
      description:
        "'compact' prints a readable summary. 'full' also appends the complete normalized JSON.",
    }),
  ),
});

const digikeySearchTool = defineTool({
  name: "digikey_search",
  label: "Digi-Key Part Search",
  description:
    "Search Digi-Key ProductSearch v4 by keyword and return normalized in-stock, non-marketplace products plus the filter options needed for a refined search. " +
    "Ground rules are enforced: marketplace excluded, out-of-stock removed, obsolete/discontinued/EOL removed, NRND kept and flagged, MOQ reported and warned above 10. " +
    "Use for component discovery and for the iterative keyword → read filterOptions → add manufacturer/status/packaging/parametric filters workflow. " +
    "For multi-constraint requests, load the digikey-part-search skill first.",
  promptSnippet: "Search Digi-Key parts (in-stock, non-marketplace) and read filter options",
  promptGuidelines: [
    "For requests with multiple constraints, load the digikey-part-search skill and follow its initial-search → read-filter-options → add-parameters loop.",
    "Start with broad keywords. Read filterOptions from the response, then call digikey_search again with manufacturerIds, statusIds, packagingIds, categoryIds, seriesIds, or parameters. Never invent filter IDs.",
    "The tool enforces ground rules: marketplace excluded, in-stock required, obsolete/discontinued/EOL parts removed, NRND parts returned but flagged, and MOQ warnings reported. Do not try to bypass them.",
    "When presenting results, explicitly call out NRND parts, high MOQ, stock levels, and status. Prefer low/no-MOQ parts.",
    "KeywordSearch returns StandardPricing only; MyPricing is not available from this endpoint.",
  ],
  exposure: "direct",
  namespace: {
    name: "digikey",
    aliases: ["dk"],
    description: "Digi-Key ProductSearch v4",
    instructions:
      "Use digikey_search in a loop: broad keyword search, read filterOptions, then re-search with IDs from that response. All filter IDs must come from Digi-Key's response.",
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  parameters: DigiKeySearchParameters,
  // Declaring an output schema makes codemode resolve tool calls to the
  // structuredContent object instead of the compact text summary.
  outputSchema: Type.Object(
    {
      query: Type.String(),
      localeUsed: Type.Object({
        site: Type.String(),
        language: Type.String(),
        currency: Type.String(),
      }),
      apiProductsCount: Type.Integer(),
      returnedProductCount: Type.Integer(),
      returnedExactMatchCount: Type.Integer(),
      filteredOut: Type.Object({}, { additionalProperties: true }),
      warnings: Type.Array(Type.String()),
      groundRules: Type.Object({}, { additionalProperties: true }),
      request: Type.Object({}, { additionalProperties: true }),
      products: Type.Array(Type.Any()),
      exactMatches: Type.Array(Type.Any()),
      filterOptions: Type.Object({}, { additionalProperties: true }),
      appliedParametricFilters: Type.Array(Type.Any()),
      notes: Type.Array(Type.String()),
    },
    { additionalProperties: true },
  ),

  async execute(_toolCallId, params, signal) {
    try {
      const result = await searchKeyword(params, {
        signal,
        configOverrides: {
          site: params.site,
          language: params.language,
          currency: params.currency,
        },
      });

      let text = formatSearchText(result.response, {
        parameterLimit: params.maxFilterParameters ?? 60,
        valuesPerParameter: params.filterValuesPerParameter ?? 20,
      });
      if (params.detail === "full") {
        text += `\n\nFull normalized result JSON:\n${JSON.stringify(result.response, null, 2)}`;
      }

      return {
        content: [{ type: "text", text }],
        details: result.response,
        structuredContent: result.response,
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
