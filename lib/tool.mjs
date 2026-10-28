/**
 * Agent-neutral definition of the `digikey_search` tool.
 *
 * Shared by the pi extension (`extensions/digikey.ts`) and the MCP server
 * (`mcp/server.mjs`). Schemas are plain JSON Schema so both hosts can use them
 * without a schema library.
 */

import { MOQ_WARN_THRESHOLD, formatSearchText, searchKeyword } from "./digikey.mjs";

export const TOOL_NAME = "digikey_search";
export const TOOL_TITLE = "Digi-Key Part Search";

export const TOOL_DESCRIPTION =
  "Search Digi-Key ProductSearch v4 by keyword and return normalized in-stock, non-marketplace products plus the filter options needed for a refined search. " +
  "Ground rules are enforced: marketplace excluded, out-of-stock removed, obsolete/discontinued/EOL removed, NRND kept and flagged, MOQ reported and warned above 10. " +
  "Use for component discovery and for the iterative keyword → read filterOptions → add manufacturer/status/packaging/parametric filters workflow. " +
  "For multi-constraint requests, load the digikey-part-search skill first.";

export const TOOL_PROMPT_SNIPPET = "Search Digi-Key parts (in-stock, non-marketplace) and read filter options";

export const TOOL_GUIDELINES = [
  "For requests with multiple constraints, load the digikey-part-search skill and follow its initial-search → read-filter-options → add-parameters loop.",
  "Start with broad keywords. Read filterOptions from the response, then call digikey_search again with manufacturerIds, statusIds, packagingIds, categoryIds, seriesIds, or parameters. Never invent filter IDs.",
  "The tool enforces ground rules: marketplace excluded, in-stock required, obsolete/discontinued/EOL parts removed, NRND parts returned but flagged, and MOQ warnings reported. Do not try to bypass them.",
  "When presenting results, explicitly call out NRND parts, high MOQ, stock levels, and status. Prefer low/no-MOQ parts.",
  "KeywordSearch returns StandardPricing only; MyPricing is not available from this endpoint.",
];

export const TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  openWorldHint: true,
});

const SORT_FIELDS = [
  "None",
  "Packaging",
  "ProductStatus",
  "DigiKeyProductNumber",
  "ManufacturerProductNumber",
  "Manufacturer",
  "MinimumQuantity",
  "QuantityAvailable",
  "Price",
  "Supplier",
  "PriceManufacturerStandardPackage",
];

const stringArray = (description) => ({ type: "array", items: { type: "string" }, description });

export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "string",
      minLength: 1,
      maxLength: 250,
      description:
        "Digi-Key keyword search string (max 250 chars). Start broad (e.g. 'audio codec', 'ceramic capacitor'), then refine using filterOptions IDs returned by the first search.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 10,
      description: "Number of products to return (1-50, default 10).",
    },
    offset: { type: "integer", minimum: 0, default: 0, description: "Pagination offset." },
    manufacturerIds: stringArray(
      "Manufacturer filter IDs from filterOptions.manufacturers[].id in a previous response. Do not invent IDs.",
    ),
    statusIds: stringArray(
      "Product status filter IDs from filterOptions.status[].id. Obsolete/EOL parts are already removed locally; use this to prefer Active or inspect NRND status IDs.",
    ),
    categoryIds: stringArray("Category filter IDs from filterOptions.topCategories[].category.categoryId."),
    packagingIds: stringArray("Packaging filter IDs from filterOptions.packaging[].id."),
    seriesIds: stringArray("Series filter IDs from filterOptions.series[].id."),
    parameters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          parameterId: {
            type: "integer",
            description: "ParameterId from filterOptions.parameters[].parameterId.",
          },
          valueIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "ValueId(s) from filterOptions.parameters[].values[].valueId.",
          },
        },
        required: ["parameterId", "valueIds"],
      },
      description:
        "Parametric filters. Only use parameterId/valueId pairs returned in filterOptions by the previous search.",
    },
    parameterCategoryId: {
      anyOf: [{ type: "string" }, { type: "integer" }],
      description:
        "Category ID for ParameterFilterRequest.CategoryFilter. Usually the selected category ID. Required by some parametric filter requests.",
    },
    minQuantityAvailable: {
      type: "integer",
      minimum: 1,
      default: 1,
      description:
        "Minimum quantity available. Use a larger value for 'high availability' (e.g. 100) and sort by QuantityAvailable.",
    },
    maxMoq: {
      type: "integer",
      minimum: 0,
      description:
        "Optional hard local filter: drop parts whose minimum order quantity exceeds this value. Omit to keep all and rely on MOQ warnings.",
    },
    moqWarnThreshold: {
      type: "integer",
      minimum: 0,
      default: MOQ_WARN_THRESHOLD,
      description: "Call out MOQ values above this threshold (default 10).",
    },
    sortField: {
      type: "string",
      enum: SORT_FIELDS,
      description:
        "Sort field. Use QuantityAvailable for high-availability requests and Price for cost-focused requests.",
    },
    sortOrder: { type: "string", enum: ["Ascending", "Descending"], default: "Descending" },
    site: {
      type: "string",
      description: "Locale site code, e.g. US, UK, DE. Defaults to DIGIKEY_SITE or US.",
    },
    language: {
      type: "string",
      description: "Locale language code, e.g. en. Defaults to DIGIKEY_LANGUAGE or en.",
    },
    currency: {
      type: "string",
      description: "Currency code, e.g. USD. Defaults to DIGIKEY_CURRENCY or USD.",
    },
    showParameterIds: {
      type: "boolean",
      default: false,
      description:
        "Include parameterId/valueId next to each product parameter in the compact text output. Structured output always includes them.",
    },
    maxFilterParameters: {
      type: "integer",
      minimum: 0,
      default: 60,
      description:
        "Text limit for parametric filter groups and product-derived hints (0 = all). The full set is always in structuredContent.",
    },
    filterValuesPerParameter: {
      type: "integer",
      minimum: 0,
      default: 20,
      description:
        "Text limit for values per parametric filter (0 = all). The full set is always in structuredContent.",
    },
    detail: {
      type: "string",
      enum: ["compact", "full"],
      default: "compact",
      description: "'compact' prints a readable summary. 'full' also appends the complete normalized JSON.",
    },
  },
  required: ["keywords"],
};

const openObject = { type: "object", additionalProperties: true };

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    localeUsed: {
      type: "object",
      properties: {
        site: { type: "string" },
        language: { type: "string" },
        currency: { type: "string" },
      },
      required: ["site", "language", "currency"],
    },
    apiProductsCount: { type: "integer" },
    returnedProductCount: { type: "integer" },
    returnedExactMatchCount: { type: "integer" },
    filteredOut: openObject,
    warnings: { type: "array", items: { type: "string" } },
    groundRules: openObject,
    request: openObject,
    products: { type: "array", items: {} },
    exactMatches: { type: "array", items: {} },
    filterOptions: openObject,
    productParameterHints: openObject,
    appliedParametricFilters: { type: "array", items: {} },
    notes: { type: "array", items: { type: "string" } },
  },
  required: [
    "query",
    "localeUsed",
    "apiProductsCount",
    "returnedProductCount",
    "returnedExactMatchCount",
    "filteredOut",
    "warnings",
    "groundRules",
    "request",
    "products",
    "exactMatches",
    "filterOptions",
    "productParameterHints",
    "appliedParametricFilters",
    "notes",
  ],
  additionalProperties: true,
};

/**
 * Run one `digikey_search` call and render the model-facing text.
 *
 * @param {object} params Tool arguments matching `INPUT_SCHEMA`.
 * @param {{signal?: AbortSignal, fetchImpl?: Function, env?: object}} [options]
 * @returns {Promise<{text: string, result: object}>} Text summary and the normalized response.
 */
export async function runDigikeySearch(params, options = {}) {
  const { response } = await searchKeyword(params, {
    ...options,
    configOverrides: {
      site: params.site,
      language: params.language,
      currency: params.currency,
    },
  });

  let text = formatSearchText(response, {
    parameterLimit: params.maxFilterParameters ?? 60,
    valuesPerParameter: params.filterValuesPerParameter ?? 20,
    includeParameterIds: params.showParameterIds ?? false,
  });
  if (params.detail === "full") {
    text += `\n\nFull normalized result JSON:\n${JSON.stringify(response, null, 2)}`;
  }
  return { text, result: response };
}
