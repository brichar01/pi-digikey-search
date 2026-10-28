/**
 * Digi-Key ProductSearch v4 client.
 *
 * This module is shared by:
 *   - the `digikey-search` CLI (`bin/digikey-search`)
 *   - the shared tool definition (`lib/tool.mjs`), used by pi and MCP
 *
 * Secrets are read only from the environment:
 *   DIGIKEY_CLIENT_ID      required
 *   DIGIKEY_CLIENT_SECRET  required
 *   DIGIKEY_ACCOUNT_ID     optional
 *   DIGIKEY_SITE           default "US"
 *   DIGIKEY_LANGUAGE       default "en"
 *   DIGIKEY_CURRENCY       default "USD"
 *   DIGIKEY_SANDBOX        "1"/"true" selects sandbox-api.digikey.com
 *   DIGIKEY_API_HOST       explicit host override
 *   DIGIKEY_TIMEOUT_MS     default 30000
 */

const PRODUCTION_HOST = "api.digikey.com";
const SANDBOX_HOST = "sandbox-api.digikey.com";
const TOKEN_PATH = "/v1/oauth2/token";
const KEYWORD_PATH = "/products/v4/search/keyword";
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_EARLY_EXPIRY_MS = 60_000;

/** MOQ values above this are called out. Low/no MOQ is preferred by the skill. */
export const MOQ_WARN_THRESHOLD = 10;

/** Status strings that must never be recommended under the ground rules. */
const OBSOLETE_RE = /\b(obsolete|discontinued|end[\s-]*of[\s-]*life|last[\s-]*time[\s-]*buy)\b/i;
/** "NRND" is kept, but every returned part with this status is explicitly flagged. */
const NRND_RE = /\b(not\s+(recommended\s+)?for\s+new\s+designs|nrnd)\b/i;

const SORT_FIELDS = new Set([
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
]);

const SORT_ORDERS = new Set(["Ascending", "Descending"]);

const HTTP_STATUS_INFO = {
  400: {
    title: "Bad Request",
    detail: "The input model is invalid or malformed.",
    hint: "Check Keywords (1-250 chars), Limit (1-50), Offset, and that every filter ID came from a previous FilterOptions response.",
  },
  401: {
    title: "Unauthorized",
    detail: "Token is expired or Client Id or subscription are invalid.",
    hint: "Check DIGIKEY_CLIENT_ID/DIGIKEY_CLIENT_SECRET, the app's Product Information v4 subscription, and whether sandbox vs production credentials are being used.",
  },
  403: {
    title: "Forbidden",
    detail: "The target resource is forbidden.",
    hint: "The app may lack access to this API, locale, or resource.",
  },
  404: {
    title: "Not Found",
    detail: "The requested resource could not be found.",
    hint: "Check the endpoint and product identifier.",
  },
  429: {
    title: "Too Many Requests",
    detail: "Your rate limit has been exceeded.",
    hint: "Back off and honor Retry-After. Do not retry in a tight loop; reuse previous search results and filter options.",
  },
  500: {
    title: "Internal Server Error",
    detail: "An unhandled error occurred.",
    hint: "Retry later. If it persists, report the correlationId to Digi-Key support.",
  },
  503: {
    title: "Service Unavailable",
    detail: "The service is temporarily unavailable.",
    hint: "Retry later with backoff.",
  },
};

export class DigiKeyConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DigiKeyConfigError";
    this.code = "CONFIG_ERROR";
    this.missing = details.missing ?? [];
  }
}

export class DigiKeyInputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DigiKeyInputError";
    this.code = "INPUT_ERROR";
    this.field = details.field;
  }
}

export class DigiKeyApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DigiKeyApiError";
    this.code = details.code ?? (details.status ? `HTTP_${details.status}` : "API_ERROR");
    this.status = details.status;
    this.problem = details.problem;
    this.retryAfter = details.retryAfter;
    this.endpoint = details.endpoint;
    this.correlationId = details.problem?.correlationId;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      retryAfter: this.retryAfter,
      endpoint: this.endpoint,
      problem: this.problem,
    };
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function parseJson(text) {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

function makeSignal(signal, timeoutMs) {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);

  // Fallback for runtimes without AbortSignal.any.
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(timeout.reason), timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    },
    { once: true },
  );
  return controller.signal;
}

function networkError(err, endpoint) {
  const name = err?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return new DigiKeyApiError(
      `DigiKey request timed out (${endpoint}). Check network connectivity or raise DIGIKEY_TIMEOUT_MS.`,
      { code: "NETWORK_TIMEOUT", endpoint },
    );
  }
  return new DigiKeyApiError(
    `Could not reach the Digi-Key API (${endpoint}): ${err instanceof Error ? err.message : String(err)}`,
    { code: "NETWORK_ERROR", endpoint },
  );
}

function formatProblemErrors(errors) {
  if (!isObject(errors)) return "";
  const lines = [];
  for (const [field, messages] of Object.entries(errors)) {
    const list = Array.isArray(messages) ? messages : [messages];
    lines.push(`${field}: ${list.map((item) => truncate(item, 300)).join("; ")}`);
  }
  return lines.join("\n");
}

function apiErrorMessage(status, problem, fallbackText, retryAfter) {
  const info = HTTP_STATUS_INFO[status] ?? {
    title: "API Error",
    detail: "The Digi-Key API returned an error.",
    hint: "Inspect the response body and status code.",
  };
  const title = problem?.title || info.title;
  const detail = problem?.detail || info.detail;
  const lines = [`Digi-Key API error (HTTP ${status} ${title}): ${detail}`];

  if (problem?.type) lines.push(`type: ${problem.type}`);
  if (problem?.correlationId) lines.push(`correlationId: ${problem.correlationId}`);
  if (problem?.instance) lines.push(`instance: ${problem.instance}`);
  const fieldErrors = formatProblemErrors(problem?.errors);
  if (fieldErrors) lines.push(`errors:\n${fieldErrors}`);
  if (retryAfter !== undefined) lines.push(`retryAfter: ${retryAfter} second(s)`);
  lines.push(`hint: ${info.hint}`);
  if (!problem && fallbackText?.trim()) {
    lines.push(`response: ${truncate(fallbackText.trim(), 800)}`);
  }
  return lines.join("\n");
}

function authErrorMessage(status, data, fallbackText) {
  const code = data?.error || `HTTP_${status}`;
  const description = data?.error_description || (status ? `OAuth token request failed with HTTP ${status}.` : "OAuth token request failed.");
  const hints = {
    invalid_client: "The client id or client secret is wrong, or the app is not enabled for this environment.",
    invalid_grant: "The credentials/grant are not valid for client-credentials OAuth.",
    unauthorized_client: "This app is not allowed to use client-credentials OAuth.",
  };
  const lines = [`Digi-Key OAuth token request failed (${code}): ${description}`];
  if (hints[code]) lines.push(`hint: ${hints[code]}`);
  lines.push(
    "hint: Verify DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET, and that the app has a Product Information v4 subscription. Sandbox and production credentials are not interchangeable.",
  );
  if (!data && fallbackText?.trim()) lines.push(`response: ${truncate(fallbackText.trim(), 800)}`);
  return lines.join("\n");
}

/**
 * Resolve environment/overrides into a request configuration.
 * Overrides are useful for the pi tool's optional site/currency parameters.
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const missing = [];
  const clientId = overrides.clientId ?? env.DIGIKEY_CLIENT_ID;
  const clientSecret = overrides.clientSecret ?? env.DIGIKEY_CLIENT_SECRET;
  if (!clientId) missing.push("DIGIKEY_CLIENT_ID");
  if (!clientSecret) missing.push("DIGIKEY_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new DigiKeyConfigError(
      `Missing required Digi-Key environment variable(s): ${missing.join(", ")}.`,
      { missing },
    );
  }

  const sandbox = overrides.sandbox ?? isTruthy(env.DIGIKEY_SANDBOX);
  const host = overrides.host || env.DIGIKEY_API_HOST || (sandbox ? SANDBOX_HOST : PRODUCTION_HOST);
  const site = String(overrides.site || env.DIGIKEY_SITE || "US").toUpperCase();
  const language = String(overrides.language || env.DIGIKEY_LANGUAGE || "en").toLowerCase();
  const currency = String(overrides.currency || env.DIGIKEY_CURRENCY || "USD").toUpperCase();
  const timeoutMs = clamp(
    toInteger(overrides.timeoutMs ?? env.DIGIKEY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    1_000,
    300_000,
  );

  return Object.freeze({
    clientId: String(clientId),
    clientSecret: String(clientSecret),
    accountId: overrides.accountId ?? env.DIGIKEY_ACCOUNT_ID,
    host,
    baseUrl: `https://${host}`,
    site,
    language,
    currency,
    timeoutMs,
    sandbox: Boolean(sandbox),
  });
}

const tokenCache = new Map();

/** Exposed for tests and long-running processes that rotate secrets. */
export function clearTokenCache() {
  tokenCache.clear();
}

async function getAccessToken(config, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new DigiKeyConfigError("No fetch implementation is available. Node 18+ is required.");
  }

  const cacheKey = `${config.host}\u0000${config.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_EARLY_EXPIRY_MS) {
    return cached.accessToken;
  }

  const endpoint = `${config.baseUrl}${TOKEN_PATH}`;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials",
  });

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: makeSignal(signal, config.timeoutMs),
    });
  } catch (err) {
    throw networkError(err, endpoint);
  }

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok || !data?.access_token) {
    throw new DigiKeyApiError(authErrorMessage(response.status, data, text), {
      status: response.status,
      problem: isObject(data) ? data : undefined,
      endpoint,
    });
  }

  const expiresIn = Math.max(60, toInteger(data.expires_in, 600));
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(30, expiresIn - TOKEN_EARLY_EXPIRY_MS / 1000) * 1000,
  });
  return data.access_token;
}

function idOf(value) {
  if (isObject(value)) return value.Id ?? value.id ?? value.ValueId ?? value.valueId;
  return value;
}

function addIdFilters(filterOptions, key, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  const current = Array.isArray(filterOptions[key]) ? filterOptions[key] : [];
  const seen = new Set(current.map((entry) => String(idOf(entry))));
  for (const value of values) {
    const id = idOf(value);
    if (id === undefined || id === null || id === "") continue;
    const stringId = String(id);
    if (seen.has(stringId)) continue;
    seen.add(stringId);
    current.push({ Id: stringId });
  }
  if (current.length > 0) filterOptions[key] = current;
}

/**
 * Build a ProductSearch v4 KeywordRequest.
 *
 * Ground rules are applied after caller input so they cannot be accidentally
 * disabled: marketplace is always excluded, in-stock is always requested, and
 * the stock threshold is at least 1.
 */
export function buildKeywordRequest(input = {}) {
  const keywords = String(input.keywords ?? "").trim();
  if (!keywords) {
    throw new DigiKeyInputError("`keywords` is required.", { field: "keywords" });
  }
  if (keywords.length > 250) {
    throw new DigiKeyInputError("`keywords` must be 250 characters or fewer.", { field: "keywords" });
  }

  const limit = clamp(toInteger(input.limit, 10), 1, 50);
  const offset = Math.max(0, toInteger(input.offset, 0));

  let filterOptions;
  try {
    filterOptions = input.filterOptionsRequest ? structuredClone(input.filterOptionsRequest) : {};
  } catch {
    filterOptions = { ...(input.filterOptionsRequest || {}) };
  }

  addIdFilters(filterOptions, "ManufacturerFilter", input.manufacturerIds);
  addIdFilters(filterOptions, "StatusFilter", input.statusIds);
  addIdFilters(filterOptions, "CategoryFilter", input.categoryIds);
  addIdFilters(filterOptions, "PackagingFilter", input.packagingIds);
  addIdFilters(filterOptions, "SeriesFilter", input.seriesIds);

  if (Array.isArray(input.parameters) && input.parameters.length > 0) {
    const parameterFilters = input.parameters.map((parameter, index) => {
      const parameterId = toInteger(parameter?.parameterId ?? parameter?.ParameterId, NaN);
      if (!Number.isInteger(parameterId)) {
        throw new DigiKeyInputError(
          `parameters[${index}].parameterId must be an integer from filterOptions.parameters[].parameterId.`,
          { field: `parameters[${index}].parameterId` },
        );
      }
      const rawValues =
        parameter?.valueIds ??
        parameter?.FilterValues?.map((entry) => idOf(entry)) ??
        [];
      const valueIds = (Array.isArray(rawValues) ? rawValues : [rawValues])
        .map(idOf)
        .filter((value) => value !== undefined && value !== null && value !== "");
      if (valueIds.length === 0) {
        throw new DigiKeyInputError(
          `parameters[${index}].valueIds must contain at least one ValueId from filterOptions.parameters[].values[].valueId.`,
          { field: `parameters[${index}].valueIds` },
        );
      }
      return {
        ParameterId: parameterId,
        FilterValues: valueIds.map((valueId) => ({ Id: String(valueId) })),
      };
    });

    const existing = filterOptions.ParameterFilterRequest || {};
    filterOptions.ParameterFilterRequest = {
      ...existing,
      ParameterFilters: parameterFilters,
    };

    const categoryId =
      input.parameterCategoryId ??
      input.categoryIds?.[0] ??
      existing.CategoryFilter?.Id ??
      existing.CategoryFilter?.id;
    if (categoryId !== undefined && categoryId !== null && categoryId !== "") {
      filterOptions.ParameterFilterRequest.CategoryFilter = { Id: String(categoryId) };
    }
  }

  const searchOptions = new Set(
    Array.isArray(filterOptions.SearchOptions) ? filterOptions.SearchOptions : [],
  );
  searchOptions.add("InStock");
  filterOptions.SearchOptions = [...searchOptions];

  const minimumQuantity = toInteger(
    input.minQuantityAvailable ?? filterOptions.MinimumQuantityAvailable,
    1,
  );
  filterOptions.MinimumQuantityAvailable = Math.max(1, minimumQuantity);

  // Non-negotiable ground rule.
  filterOptions.MarketPlaceFilter = "ExcludeMarketPlace";

  const request = {
    Keywords: keywords,
    Limit: limit,
    Offset: offset,
    FilterOptionsRequest: filterOptions,
  };

  const sortField = input.sortField ?? input.sortOptions?.Field;
  const sortOrder = input.sortOrder ?? input.sortOptions?.SortOrder;
  if (sortField !== undefined && sortField !== null && sortField !== "" && sortField !== "None") {
    if (!SORT_FIELDS.has(sortField)) {
      throw new DigiKeyInputError(
        `Unsupported sortField "${sortField}". Use one of: ${[...SORT_FIELDS].join(", ")}.`,
        { field: "sortField" },
      );
    }
    const order = sortOrder ?? "Descending";
    if (!SORT_ORDERS.has(order)) {
      throw new DigiKeyInputError(
        `Unsupported sortOrder "${order}". Use Ascending or Descending.`,
        { field: "sortOrder" },
      );
    }
    request.SortOptions = { Field: sortField, SortOrder: order };
  }

  return request;
}

/**
 * Execute one keyword search.
 *
 * @returns {{request: object, response: object, raw: object}}
 */
export async function searchKeyword(input, options = {}) {
  const config = options.config ?? resolveConfig(options.configOverrides ?? {}, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new DigiKeyConfigError("No fetch implementation is available. Node 18+ is required.");
  }

  const request = buildKeywordRequest(input);
  const accessToken = await getAccessToken(config, {
    fetchImpl,
    signal: options.signal,
  });

  const endpoint = `${config.baseUrl}${KEYWORD_PATH}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-DIGIKEY-Client-Id": config.clientId,
        "X-DIGIKEY-Locale-Site": config.site,
        "X-DIGIKEY-Locale-Language": config.language,
        "X-DIGIKEY-Locale-Currency": config.currency,
      },
      body: JSON.stringify(request),
      signal: makeSignal(options.signal, config.timeoutMs),
    });
  } catch (err) {
    throw networkError(err, endpoint);
  }

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const problem = isObject(data) ? data : undefined;
    const retryAfter = parseRetryAfter(response.headers);
    throw new DigiKeyApiError(apiErrorMessage(response.status, problem, text, retryAfter), {
      status: response.status,
      problem,
      retryAfter,
      endpoint,
    });
  }
  if (!isObject(data)) {
    throw new DigiKeyApiError(
      `Digi-Key returned a non-JSON or empty success response (${endpoint}): ${truncate(text, 800)}`,
      { status: response.status, code: "INVALID_RESPONSE", endpoint },
    );
  }

  return {
    request,
    response: normalizeKeywordResponse(data, { config, input, request }),
    raw: data,
  };
}

function normalizeLocale(locale, config) {
  return {
    site: locale?.Site ?? config.site,
    language: locale?.Language ?? config.language,
    currency: locale?.Currency ?? config.currency,
  };
}

function normalizeFilterValue(value) {
  return {
    valueId: value?.ValueId === undefined || value?.ValueId === null ? null : String(value.ValueId),
    name: value?.ValueName ?? "",
    productCount: toInteger(value?.ProductCount, 0),
    rangeFilterType: value?.RangeFilterType ?? null,
  };
}

function normalizeBaseFilter(entry) {
  return {
    id: entry?.Id === undefined || entry?.Id === null ? null : String(entry.Id),
    name: entry?.Value ?? "",
    productCount: toInteger(entry?.ProductCount, 0),
  };
}

function normalizeCategoryNode(node) {
  if (!node) return null;
  return {
    categoryId: node.CategoryId ?? node.Id ?? null,
    parentId: node.ParentId ?? null,
    name: node.Name ?? "",
    productCount: toInteger(node.ProductCount, 0),
    newProductCount: toInteger(node.NewProductCount, 0),
    childCategories: Array.isArray(node.ChildCategories)
      ? node.ChildCategories.map(normalizeCategoryNode).filter(Boolean)
      : [],
  };
}

function normalizeTopCategory(entry) {
  if (!entry) return null;
  return {
    rootCategory: normalizeCategoryNode(entry.RootCategory),
    category: normalizeCategoryNode(entry.Category),
    score: entry.Score ?? null,
    imageUrl: entry.ImageUrl ?? null,
  };
}

export function normalizeFilterOptions(filterOptions) {
  if (!isObject(filterOptions)) {
    return {
      manufacturers: [],
      packaging: [],
      status: [],
      series: [],
      parameters: [],
      topCategories: [],
      marketplaceFilters: [],
    };
  }

  return {
    manufacturers: (filterOptions.Manufacturers ?? []).map(normalizeBaseFilter),
    packaging: (filterOptions.Packaging ?? []).map(normalizeBaseFilter),
    status: (filterOptions.Status ?? []).map(normalizeBaseFilter),
    series: (filterOptions.Series ?? []).map(normalizeBaseFilter),
    parameters: (filterOptions.ParametricFilters ?? []).map((parameter) => ({
      parameterId: parameter?.ParameterId ?? null,
      parameterName: parameter?.ParameterName ?? "",
      parameterType: parameter?.ParameterType ?? null,
      category: parameter?.Category ? normalizeBaseFilter(parameter.Category) : null,
      values: (parameter?.FilterValues ?? []).map(normalizeFilterValue),
    })),
    topCategories: (filterOptions.TopCategories ?? []).map(normalizeTopCategory).filter(Boolean),
    marketplaceFilters: Array.isArray(filterOptions.MarketPlaceFilters)
      ? [...filterOptions.MarketPlaceFilters]
      : [],
  };
}

function normalizeParameterValue(parameter) {
  return {
    parameterId: parameter?.ParameterId ?? null,
    name: parameter?.ParameterText ?? "",
    type: parameter?.ParameterType ?? null,
    valueId: parameter?.ValueId ?? null,
    value: parameter?.ValueText ?? "",
  };
}

function collectLeafCategoryNodes(node, leaves = []) {
  if (!node) return leaves;
  const children = Array.isArray(node.childCategories) ? node.childCategories : [];
  if (children.length === 0) {
    if (node.categoryId !== null && node.categoryId !== undefined) leaves.push(node);
    return leaves;
  }
  for (const child of children) collectLeafCategoryNodes(child, leaves);
  return leaves;
}

/**
 * When Digi-Key does not return FilterOptions.ParametricFilters (common for
 * broad keyword searches), product parameters still carry the same
 * ParameterId/ValueId namespace. Derive candidate filters from them so callers
 * can refine instead of being stuck with manufacturer-only filtering.
 */
function deriveProductParameterHints(products, filterOptions) {
  const hints = {
    source: "products[].parameters",
    reason: "filterOptions.parameters is populated; product-derived hints not needed",
    categories: [],
    parameters: [],
  };
  if (filterOptions.parameters.length > 0) return hints;

  hints.reason = "filterOptions.parameters was empty; derived from returned products";
  const categories = new Map();
  const parameters = new Map();

  products.forEach((product, productIndex) => {
    const leaves = collectLeafCategoryNodes(product.category);
    const categoryIds = [];
    for (const leaf of leaves) {
      const id = String(leaf.categoryId);
      if (!categoryIds.includes(id)) categoryIds.push(id);
      let category = categories.get(id);
      if (!category) {
        category = { id, name: leaf.name || "", products: new Set() };
        categories.set(id, category);
      }
      category.products.add(productIndex);
    }

    for (const parameter of product.parameters ?? []) {
      if (parameter.parameterId === null || parameter.parameterId === undefined) continue;
      const key = String(parameter.parameterId);
      let hint = parameters.get(key);
      if (!hint) {
        hint = {
          parameterId: parameter.parameterId,
          parameterName: parameter.name || `Parameter ${parameter.parameterId}`,
          parameterType: parameter.type ?? null,
          categoryIds: new Set(),
          values: new Map(),
        };
        parameters.set(key, hint);
      }
      for (const categoryId of categoryIds) hint.categoryIds.add(categoryId);

      if (
        parameter.valueId === null ||
        parameter.valueId === undefined ||
        parameter.valueId === "" ||
        parameter.value === "-"
      ) {
        continue;
      }
      const valueKey = `${parameter.valueId}\u0000${parameter.value ?? ""}`;
      let value = hint.values.get(valueKey);
      if (!value) {
        value = {
          valueId: String(parameter.valueId),
          name: parameter.value ?? "",
          productCount: 0,
          products: new Set(),
          categoryIds: new Set(),
        };
        hint.values.set(valueKey, value);
      }
      if (!value.products.has(productIndex)) {
        value.products.add(productIndex);
        value.productCount += 1;
      }
      for (const categoryId of categoryIds) value.categoryIds.add(categoryId);
    }
  });

  hints.categories = [...categories.values()]
    .map((category) => ({
      id: category.id,
      name: category.name,
      productCount: category.products.size,
    }))
    .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name));

  hints.parameters = [...parameters.values()]
    .map((hint) => ({
      parameterId: hint.parameterId,
      parameterName: hint.parameterName,
      parameterType: hint.parameterType,
      categoryIds: [...hint.categoryIds],
      values: [...hint.values.values()]
        .map((value) => ({
          valueId: value.valueId,
          name: value.name,
          productCount: value.productCount,
          categoryIds: [...value.categoryIds],
        }))
        .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)),
    }))
    .filter((hint) => hint.values.length > 0)
    .sort((a, b) => a.parameterName.localeCompare(b.parameterName));

  return hints;
}

function normalizePriceBreak(priceBreak) {
  return {
    breakQuantity: priceBreak?.BreakQuantity ?? null,
    unitPrice: priceBreak?.UnitPrice ?? null,
    totalPrice: priceBreak?.TotalPrice ?? null,
  };
}

function normalizeVariation(variation) {
  const marketplace = variation?.MarketPlace === true;
  const quantityAvailable = toInteger(variation?.QuantityAvailableforPackageType, 0);
  const minimumOrderQuantity = toInteger(variation?.MinimumOrderQuantity, null);
  return {
    digiKeyProductNumber: variation?.DigiKeyProductNumber ?? "",
    packageType: variation?.PackageType?.Name ?? null,
    packageTypeId: variation?.PackageType?.Id ?? null,
    quantityAvailable,
    minimumOrderQuantity:
      minimumOrderQuantity === null ? null : Math.max(0, minimumOrderQuantity),
    maxQuantityForDistribution: variation?.MaxQuantityForDistribution ?? null,
    marketplace,
    standardPricing: (variation?.StandardPricing ?? []).map(normalizePriceBreak),
    myPricing: (variation?.MyPricing ?? []).map(normalizePriceBreak),
    tariffActive: variation?.TariffActive ?? variation?.IsTariffActive ?? false,
    digiReelFee: variation?.DigiReelFee ?? variation?.DigiReelingFee ?? null,
    supplier: variation?.Supplier?.Name ?? null,
    inStock: quantityAvailable > 0,
  };
}

function pickBestVariation(variations) {
  return [...variations].sort((a, b) => {
    const stockA = a.inStock ? 1 : 0;
    const stockB = b.inStock ? 1 : 0;
    if (stockA !== stockB) return stockB - stockA;
    const moqA = a.minimumOrderQuantity ?? Number.MAX_SAFE_INTEGER;
    const moqB = b.minimumOrderQuantity ?? Number.MAX_SAFE_INTEGER;
    if (moqA !== moqB) return moqA - moqB;
    const priceA = a.standardPricing?.[0]?.unitPrice ?? Number.MAX_SAFE_INTEGER;
    const priceB = b.standardPricing?.[0]?.unitPrice ?? Number.MAX_SAFE_INTEGER;
    return priceA - priceB;
  })[0];
}

function normalizeProduct(raw, options) {
  if (!isObject(raw)) return { skip: "malformed" };

  const allVariations = Array.isArray(raw.ProductVariations) ? raw.ProductVariations : [];
  const nonMarketplaceVariations = allVariations.filter((variation) => variation?.MarketPlace !== true);
  if (raw.MarketPlace === true || (allVariations.length > 0 && nonMarketplaceVariations.length === 0)) {
    return { skip: "marketplace" };
  }

  const status =
    (isObject(raw.ProductStatus) ? raw.ProductStatus.Status : raw.ProductStatus) ??
    (raw.Discontinued ? "Discontinued" : raw.EndOfLife ? "End Of Life" : "Unknown");
  const statusId = isObject(raw.ProductStatus) ? (raw.ProductStatus.Id ?? null) : null;

  if (
    raw.Discontinued === true ||
    raw.EndOfLife === true ||
    OBSOLETE_RE.test(String(status))
  ) {
    return { skip: "obsolete" };
  }

  const variationStock = nonMarketplaceVariations.reduce(
    (sum, variation) => sum + Math.max(0, toInteger(variation?.QuantityAvailableforPackageType, 0)),
    0,
  );
  // Prefer non-marketplace variation stock. Product-level QuantityAvailable can
  // include marketplace quantity, which the ground rules exclude.
  const quantityAvailable =
    nonMarketplaceVariations.length > 0
      ? variationStock
      : Math.max(0, toInteger(raw.QuantityAvailable, 0));
  if (quantityAvailable <= 0) return { skip: "outOfStock" };

  const variations = nonMarketplaceVariations.map(normalizeVariation);
  const moqValues = variations
    .map((variation) => variation.minimumOrderQuantity)
    .filter((value) => Number.isFinite(value) && value > 0);
  const minimumOrderQuantity = moqValues.length > 0 ? Math.min(...moqValues) : null;
  if (
    options.maxMoq !== null &&
    options.maxMoq !== undefined &&
    minimumOrderQuantity !== null &&
    minimumOrderQuantity > options.maxMoq
  ) {
    return { skip: "highMoq" };
  }

  const warnings = [];
  const nrnd = NRND_RE.test(String(status));
  if (nrnd) warnings.push("NRND: Not recommended for new designs");
  if (
    minimumOrderQuantity !== null &&
    minimumOrderQuantity > options.moqWarnThreshold
  ) {
    warnings.push(`High MOQ: ${minimumOrderQuantity} (preferred <= ${options.moqWarnThreshold})`);
  }
  if (/preliminary/i.test(String(status))) warnings.push("Preliminary status");
  if (raw.Ncnr === true) warnings.push("NCNR: non-cancellable/non-returnable");
  if (raw.BackOrderNotAllowed === true) warnings.push("Backorders not allowed");

  const bestVariation = pickBestVariation(variations);
  const unitPrice =
    bestVariation?.standardPricing?.[0]?.unitPrice ??
    raw.UnitPrice ??
    null;
  const description = raw.Description ?? {};
  const parameters = (raw.Parameters ?? []).map(normalizeParameterValue);
  const packageTypes = [...new Set(variations.map((variation) => variation.packageType).filter(Boolean))];

  return {
    product: {
      digiKeyProductNumber: bestVariation?.digiKeyProductNumber ?? null,
      manufacturerPartNumber: raw.ManufacturerProductNumber ?? "",
      manufacturer: raw.Manufacturer?.Name ?? "",
      manufacturerId: raw.Manufacturer?.Id ?? null,
      description: description.ProductDescription ?? "",
      detailedDescription: description.DetailedDescription ?? "",
      status,
      statusId,
      nrnd,
      obsolete: false,
      discontinued: raw.Discontinued === true,
      endOfLife: raw.EndOfLife === true,
      inStock: true,
      marketplace: false,
      quantityAvailable,
      unitPrice,
      currency: options.currency,
      minimumOrderQuantity,
      lowMoq:
        minimumOrderQuantity !== null &&
        minimumOrderQuantity <= options.moqWarnThreshold,
      moqWarning:
        minimumOrderQuantity !== null &&
        minimumOrderQuantity > options.moqWarnThreshold
          ? `MOQ ${minimumOrderQuantity} exceeds preferred <= ${options.moqWarnThreshold}`
          : null,
      packageTypes,
      bestVariation,
      variations,
      parameters,
      warnings,
      productUrl: raw.ProductUrl ?? null,
      datasheetUrl: raw.DatasheetUrl ?? null,
      photoUrl: raw.PhotoUrl ?? null,
      primaryVideoUrl: raw.PrimaryVideoUrl ?? null,
      manufacturerLeadWeeks: raw.ManufacturerLeadWeeks ?? null,
      manufacturerPublicQuantity: raw.ManufacturerPublicQuantity ?? null,
      normallyStocking: raw.NormallyStocking ?? null,
      backOrderNotAllowed: raw.BackOrderNotAllowed ?? null,
      ncnr: raw.Ncnr ?? null,
      series: raw.Series ? { id: raw.Series.Id ?? null, name: raw.Series.Name ?? "" } : null,
      category: normalizeCategoryNode(raw.Category),
      baseProductNumber: raw.BaseProductNumber
        ? { id: raw.BaseProductNumber.Id ?? null, name: raw.BaseProductNumber.Name ?? "" }
        : null,
      classifications: raw.Classifications ?? null,
      otherNames: Array.isArray(raw.OtherNames) ? raw.OtherNames : [],
      dateLastBuyChance: raw.DateLastBuyChance ?? null,
      shippingInfo: raw.ShippingInfo ?? null,
    },
  };
}

/**
 * Normalize a KeywordResponse and apply local ground rules that the API's
 * keyword filter cannot express reliably (obsolete statuses, marketplace-only
 * products, zero stock after filtering).
 */
function normalizeKeywordResponse(data, { config, input, request }) {
  const maxMoq = input.maxMoq === undefined || input.maxMoq === null
    ? null
    : Math.max(0, toInteger(input.maxMoq, null));
  const moqWarnThreshold = Math.max(
    0,
    toInteger(input.moqWarnThreshold ?? MOQ_WARN_THRESHOLD, MOQ_WARN_THRESHOLD),
  );
  const options = {
    maxMoq,
    moqWarnThreshold,
    currency: data.SearchLocaleUsed?.Currency ?? config.currency,
  };

  const filteredOut = {
    marketplace: 0,
    outOfStock: 0,
    obsolete: 0,
    highMoq: 0,
    malformed: 0,
  };

  const processProduct = (raw) => {
    const outcome = normalizeProduct(raw, options);
    if (outcome.skip) {
      filteredOut[outcome.skip] = (filteredOut[outcome.skip] ?? 0) + 1;
      return null;
    }
    return outcome.product;
  };

  const products = (data.Products ?? []).map(processProduct).filter(Boolean);
  const exactMatches = (data.ExactMatches ?? []).map(processProduct).filter(Boolean);
  const all = [...exactMatches, ...products];
  const nrndProducts = all.filter((product) => product.nrnd);
  const highMoqProducts = all.filter((product) => product.moqWarning);

  const warnings = [];
  if (nrndProducts.length > 0) {
    warnings.push(
      `NRND: ${nrndProducts.length} returned part(s) are Not Recommended for New Designs. Call this out explicitly.`,
    );
  }
  if (highMoqProducts.length > 0) {
    warnings.push(
      `MOQ: ${highMoqProducts.length} returned part(s) have MOQ > ${moqWarnThreshold}. Prefer low/no-MOQ parts.`,
    );
  }
  if (filteredOut.obsolete > 0) {
    warnings.push(`Ground rules removed ${filteredOut.obsolete} obsolete/discontinued/EOL part(s).`);
  }
  if (filteredOut.outOfStock > 0) {
    warnings.push(`Ground rules removed ${filteredOut.outOfStock} out-of-stock part(s).`);
  }
  if (filteredOut.marketplace > 0) {
    warnings.push(`Ground rules removed ${filteredOut.marketplace} marketplace part(s).`);
  }
  if (filteredOut.highMoq > 0) {
    warnings.push(
      `Ground rules removed ${filteredOut.highMoq} part(s) above maxMoq=${maxMoq}.`,
    );
  }

  const filterOptions = normalizeFilterOptions(data.FilterOptions);

  return {
    query: request.Keywords,
    localeUsed: normalizeLocale(data.SearchLocaleUsed, config),
    apiProductsCount: toInteger(data.ProductsCount, (data.Products ?? []).length),
    returnedProductCount: products.length,
    returnedExactMatchCount: exactMatches.length,
    filteredOut,
    warnings,
    groundRules: {
      marketplace: "excluded",
      inStock: "required",
      obsoleteStatuses: "excluded",
      nrnd: "kept and flagged",
      moqWarnThreshold,
      maxMoq,
    },
    request,
    products,
    exactMatches,
    filterOptions,
    productParameterHints: deriveProductParameterHints(all, filterOptions),
    appliedParametricFilters: (data.AppliedParametricFiltersDto ?? []).map((parameter) => ({
      parameterId: parameter?.Id ?? null,
      text: parameter?.Text ?? "",
      priority: parameter?.Priority ?? null,
    })),
    notes: [
      "KeywordSearch returns StandardPricing only; MyPricing is not available from this endpoint.",
      "Filter value IDs in filterOptions are the only IDs that should be used in a subsequent request.",
    ],
  };
}

function formatPrice(product) {
  if (product.unitPrice === null || product.unitPrice === undefined) return "price n/a";
  const currency = product.currency || "USD";
  const value = Number(product.unitPrice);
  const digits = value >= 1 ? 2 : 4;
  return `${currency} ${value.toFixed(digits)}`;
}

function formatProductParameters(product, options = {}) {
  if (!product.parameters?.length) return "";
  const maxLength = options.maxLength ?? 500;
  const includeIds = options.includeParameterIds === true;
  const text = product.parameters
    .map((parameter) => {
      const name = parameter.name || `param ${parameter.parameterId}`;
      const value = parameter.value || parameter.valueId || "?";
      const ids = includeIds
        ? ` [parameterId=${parameter.parameterId ?? "?"}, valueId=${parameter.valueId ?? "?"}]`
        : "";
      return `${name}=${value}${ids}`;
    })
    .join("; ");
  return truncate(text, maxLength);
}

function formatProduct(product, index, options = {}) {
  const flags = [];
  if (product.nrnd) flags.push("NRND");
  if (product.moqWarning) flags.push("HIGH MOQ");
  if (product.ncnr) flags.push("NCNR");
  const flagText = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  const lines = [
    `${index}. ${product.digiKeyProductNumber || "(no DK part number)"} — ${product.manufacturer} ${product.manufacturerPartNumber}${flagText}`,
    `   ${truncate(product.description, 180)}`,
    `   status=${product.status}; stock=${product.quantityAvailable}; MOQ=${product.minimumOrderQuantity ?? "n/a"}; ${formatPrice(product)}; packages=${product.packageTypes.join(", ") || "n/a"}`,
  ];
  const parameters = formatProductParameters(product, {
    includeParameterIds: options.includeParameterIds,
    maxLength:
      options.productParameterMaxLength ??
      (options.includeParameterIds ? 1200 : 500),
  });
  if (parameters) lines.push(`   params: ${parameters}`);
  if (product.productUrl) lines.push(`   product: ${product.productUrl}`);
  if (product.datasheetUrl) lines.push(`   datasheet: ${product.datasheetUrl}`);
  for (const warning of product.warnings) lines.push(`   warning: ${warning}`);
  return lines.join("\n");
}

function formatFilterValues(parameter, valuesPerParameter) {
  const shown = valuesPerParameter > 0
    ? parameter.values.slice(0, valuesPerParameter)
    : parameter.values;
  const values = shown.map((value) => {
    const range = value.rangeFilterType ? `, ${value.rangeFilterType}` : "";
    return `${value.name || "(unnamed)"} (id=${value.valueId ?? "null"}, count=${value.productCount}${range})`;
  });
  const remaining = parameter.values.length - shown.length;
  if (remaining > 0) values.push(`… +${remaining} more values`);
  return values.join(", ");
}

/**
 * Format a normalized response for a model or terminal.
 * The full structured response is still returned by the tool for codemode.
 */
export function formatSearchText(result, options = {}) {
  const manufacturerLimit = options.manufacturerLimit ?? 40;
  const seriesLimit = options.seriesLimit ?? 20;
  const parameterLimit = options.parameterLimit ?? 60;
  const valuesPerParameter = options.valuesPerParameter ?? 20;

  const lines = [];
  lines.push(
    `DigiKey keyword search: "${result.query}" — ${result.apiProductsCount} API match(es), ${result.returnedProductCount} returned after ground rules.`,
  );
  lines.push(
    `Locale used: site=${result.localeUsed.site}, language=${result.localeUsed.language}, currency=${result.localeUsed.currency}`,
  );
  lines.push(
    "Ground rules: marketplace excluded; in stock required; obsolete/discontinued/EOL excluded; NRND kept and flagged; prefer low/no MOQ.",
  );

  const removed = Object.entries(result.filteredOut)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  if (removed.length > 0) lines.push(`Removed locally: ${removed.join(", ")}`);

  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  if (result.exactMatches.length > 0) {
    lines.push("", "Exact matches:");
    result.exactMatches.forEach((product, index) => {
      lines.push(formatProduct(product, index + 1, options));
    });
  }

  lines.push("", result.products.length > 0 ? "Products:" : "Products: none after ground-rule filtering.");
  result.products.forEach((product, index) => {
    lines.push(formatProduct(product, index + 1, options));
  });

  const filters = result.filterOptions;
  lines.push("", "Filter options from this search (use these IDs in the next request):");

  if (filters.manufacturers.length > 0) {
    const shown = manufacturerLimit > 0
      ? filters.manufacturers.slice(0, manufacturerLimit)
      : filters.manufacturers;
    lines.push(
      `Manufacturers (${shown.length}/${filters.manufacturers.length}): ` +
        shown.map((entry) => `${entry.name} (id=${entry.id}, count=${entry.productCount})`).join(", "),
    );
  }
  if (filters.status.length > 0) {
    lines.push(
      "Status: " +
        filters.status
          .map((entry) => `${entry.name} (id=${entry.id}, count=${entry.productCount})`)
          .join(", "),
    );
  }
  if (filters.packaging.length > 0) {
    lines.push(
      "Packaging: " +
        filters.packaging
          .map((entry) => `${entry.name} (id=${entry.id}, count=${entry.productCount})`)
          .join(", "),
    );
  }
  if (filters.series.length > 0) {
    const shown = seriesLimit > 0 ? filters.series.slice(0, seriesLimit) : filters.series;
    lines.push(
      `Series (${shown.length}/${filters.series.length}): ` +
        shown.map((entry) => `${entry.name} (id=${entry.id}, count=${entry.productCount})`).join(", "),
    );
  }
  if (filters.topCategories.length > 0) {
    lines.push(
      "Top categories: " +
        filters.topCategories
          .map((entry) => {
            const category = entry.category ?? entry.rootCategory;
            return `${category?.name ?? "(unnamed)"} (id=${category?.categoryId ?? "?"}, count=${category?.productCount ?? 0})`;
          })
          .join(", "),
    );
  }

  if (filters.parameters.length > 0) {
    const shown = parameterLimit > 0
      ? filters.parameters.slice(0, parameterLimit)
      : filters.parameters;
    lines.push(
      "",
      `Parametric filters (${shown.length}/${filters.parameters.length}; top values shown):`,
    );
    for (const parameter of shown) {
      lines.push(
        `- ${parameter.parameterName} [parameterId=${parameter.parameterId ?? "?"}] type=${parameter.parameterType ?? "?"}`,
      );
      const values = formatFilterValues(parameter, valuesPerParameter);
      if (values) lines.push(`    ${values}`);
    }
    if (filters.parameters.length > shown.length) {
      lines.push(
        `… ${filters.parameters.length - shown.length} more parametric filter(s) omitted; raise maxFilterParameters or use codemode for the full structured response.`,
      );
    }
  } else {
    lines.push("Parametric filters: none returned.");
  }

  const hints = result.productParameterHints;
  if (filters.parameters.length === 0 && hints?.parameters?.length > 0) {
    const shown = parameterLimit > 0
      ? hints.parameters.slice(0, parameterLimit)
      : hints.parameters;
    lines.push(
      "",
      `Product-derived parametric filter hints (${shown.length}/${hints.parameters.length}; filterOptions.parameters was empty):`,
    );
    if (hints.categories.length > 0) {
      lines.push(
        "  parameterCategoryId candidates: " +
          hints.categories
            .map(
              (category) =>
                `${category.name || "(unnamed)"} (id=${category.id}, count=${category.productCount})`,
            )
            .join(", "),
      );
    }
    for (const parameter of shown) {
      const categoryText = parameter.categoryIds.length > 0
        ? `; categoryIds=${parameter.categoryIds.join(",")}`
        : "";
      lines.push(
        `- ${parameter.parameterName} [parameterId=${parameter.parameterId ?? "?"}] type=${parameter.parameterType ?? "?"}${categoryText}`,
      );
      const values = formatFilterValues(parameter, valuesPerParameter);
      if (values) lines.push(`    ${values}`);
    }
    if (hints.parameters.length > shown.length) {
      lines.push(
        `… ${hints.parameters.length - shown.length} more product-derived filter hint(s) omitted; raise the parameter limit or use codemode/JSON for the full set.`,
      );
    }
    lines.push(
      "  These IDs came from products[].parameters. Use a non-parent parameterCategoryId (a child category) when filtering.",
    );
  }

  if (result.appliedParametricFilters.length > 0) {
    lines.push(
      "",
      "Applied parametric filters: " +
        result.appliedParametricFilters
          .map((parameter) => `${parameter.text || parameter.parameterId}`)
          .join("; "),
    );
  }

  lines.push(
    "",
    "Refine by calling digikey_search again with the same keywords and IDs from the sections above:",
    "  manufacturerIds: [...], statusIds: [...], packagingIds: [...], categoryIds: [...], seriesIds: [...],",
    "  parameters: [{ parameterId: <number>, valueIds: [\"<ValueId>\"] }], parameterCategoryId: <category id>.",
    "Never invent filter IDs. If a needed filter is omitted, raise maxFilterParameters or use codemode to read the full structured response.",
  );

  return lines.join("\n");
}

export function formatError(error) {
  if (error instanceof DigiKeyConfigError) {
    return [
      `Digi-Key configuration error: ${error.message}`,
      "Required environment variables: DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET.",
      "Optional: DIGIKEY_ACCOUNT_ID, DIGIKEY_SITE, DIGIKEY_LANGUAGE, DIGIKEY_CURRENCY, DIGIKEY_SANDBOX, DIGIKEY_API_HOST, DIGIKEY_TIMEOUT_MS.",
    ].join("\n");
  }
  if (error instanceof DigiKeyInputError) {
    return `Digi-Key request input error: ${error.message}`;
  }
  if (error instanceof DigiKeyApiError) {
    return error.message;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const HELP = `digikey-search — Digi-Key ProductSearch v4 keyword search

Usage:
  digikey-search --keywords "audio codec" [options]
  digikey-search --request request.json [options]

Required environment:
  DIGIKEY_CLIENT_ID       Digi-Key API client id
  DIGIKEY_CLIENT_SECRET   Digi-Key API client secret

Optional environment:
  DIGIKEY_ACCOUNT_ID      Account id (not needed for KeywordSearch)
  DIGIKEY_SITE            Default US
  DIGIKEY_LANGUAGE        Default en
  DIGIKEY_CURRENCY        Default USD
  DIGIKEY_SANDBOX         "1" to use sandbox-api.digikey.com
  DIGIKEY_API_HOST        Explicit API host
  DIGIKEY_TIMEOUT_MS      Default 30000

Search options:
  -k, --keywords TEXT           Keywords (required unless --request)
      --limit N                 Results to return, 1-50 (default 10)
      --offset N                Starting offset (default 0)
      --manufacturer-id ID      Manufacturer filter id (repeatable)
      --status-id ID            Status filter id (repeatable)
      --category-id ID          Category filter id (repeatable)
      --packaging-id ID         Packaging filter id (repeatable)
      --series-id ID            Series filter id (repeatable)
      --parameter ID=VALUEID    Parametric filter (repeatable; comma-separate values)
      --parameter-category ID   Category id for parametric filters
      --min-qty N               Minimum quantity available (default 1)
      --max-moq N               Locally drop parts with MOQ above N
      --moq-warn N              MOQ warning threshold (default 10)
      --sort FIELD              e.g. QuantityAvailable, Price, Manufacturer
      --order asc|desc          Sort direction (default desc)
      --site CODE               Locale site (default US)
      --language CODE           Locale language (default en)
      --currency CODE           Locale currency (default USD)
      --request FILE            Read input JSON from FILE, or "-" for stdin
      --format json|text        Output format (default json)
      --show-parameter-ids      Include parameterId/valueId in text product params
      --raw                     Print the raw Digi-Key response
      --help                    Show this help

Ground rules (always applied):
  marketplace excluded, in-stock required, obsolete/discontinued/EOL parts
  removed, NRND parts kept and flagged, MOQ reported and warned above 10.

Exit codes:
  0 success, 2 usage/input, 3 configuration/auth, 4 API/network error
`;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseArgs(argv) {
  const input = {};
  const filters = [];
  let requestFile;
  let format = "json";
  let showParameterIds = false;
  let raw = false;
  let help = false;

  const next = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined) throw new DigiKeyInputError(`${flag} requires a value.`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "-k":
      case "--keywords":
        input.keywords = next(index, arg);
        index += 1;
        break;
      case "--limit":
        input.limit = toInteger(next(index, arg), undefined);
        index += 1;
        break;
      case "--offset":
        input.offset = toInteger(next(index, arg), undefined);
        index += 1;
        break;
      case "--manufacturer-id":
        (input.manufacturerIds ??= []).push(next(index, arg));
        index += 1;
        break;
      case "--status-id":
        (input.statusIds ??= []).push(next(index, arg));
        index += 1;
        break;
      case "--category-id":
        (input.categoryIds ??= []).push(next(index, arg));
        index += 1;
        break;
      case "--packaging-id":
        (input.packagingIds ??= []).push(next(index, arg));
        index += 1;
        break;
      case "--series-id":
        (input.seriesIds ??= []).push(next(index, arg));
        index += 1;
        break;
      case "--parameter": {
        const value = next(index, arg);
        index += 1;
        const [parameterId, values = ""] = value.split("=", 2);
        if (!parameterId || !values) {
          throw new DigiKeyInputError(
            `--parameter expects ID=VALUEID[,VALUEID...], got "${value}".`,
          );
        }
        filters.push({
          parameterId: toInteger(parameterId, NaN),
          valueIds: values.split(",").map((entry) => entry.trim()).filter(Boolean),
        });
        break;
      }
      case "--parameter-category":
        input.parameterCategoryId = next(index, arg);
        index += 1;
        break;
      case "--min-qty":
        input.minQuantityAvailable = toInteger(next(index, arg), undefined);
        index += 1;
        break;
      case "--max-moq":
        input.maxMoq = toInteger(next(index, arg), undefined);
        index += 1;
        break;
      case "--moq-warn":
        input.moqWarnThreshold = toInteger(next(index, arg), undefined);
        index += 1;
        break;
      case "--sort":
        input.sortField = next(index, arg);
        index += 1;
        break;
      case "--order": {
        const order = next(index, arg);
        index += 1;
        input.sortOrder = /^a/i.test(order) ? "Ascending" : "Descending";
        break;
      }
      case "--site":
        input.site = next(index, arg);
        index += 1;
        break;
      case "--language":
        input.language = next(index, arg);
        index += 1;
        break;
      case "--currency":
        input.currency = next(index, arg);
        index += 1;
        break;
      case "--request":
        requestFile = next(index, arg);
        index += 1;
        break;
      case "--format": {
        format = next(index, arg);
        index += 1;
        if (!["json", "text"].includes(format)) {
          throw new DigiKeyInputError(`--format must be json or text, got "${format}".`);
        }
        break;
      }
      case "--show-parameter-ids":
        showParameterIds = true;
        break;
      case "--raw":
        raw = true;
        break;
      default:
        if (arg.startsWith("-")) throw new DigiKeyInputError(`Unknown option "${arg}".`);
        throw new DigiKeyInputError(`Unexpected argument "${arg}".`);
    }
  }

  if (filters.length > 0) input.parameters = filters;
  return { input, requestFile, format, showParameterIds, raw, help };
}

async function readRequestFile(file) {
  const { readFile } = await import("node:fs/promises");
  const text = file === "-" ? await readStdin() : await readFile(file, "utf8");
  const data = parseJson(text);
  if (!isObject(data)) {
    throw new DigiKeyInputError(`Request file "${file}" does not contain a JSON object.`);
  }
  return data;
}

function mergeInput(base, overrides) {
  const merged = { ...base, ...overrides };
  for (const key of [
    "manufacturerIds",
    "statusIds",
    "categoryIds",
    "packagingIds",
    "seriesIds",
    "parameters",
  ]) {
    if (Array.isArray(overrides[key]) && overrides[key].length > 0) {
      merged[key] = [...(base[key] ?? []), ...overrides[key]];
    }
  }
  if (overrides.filterOptionsRequest) merged.filterOptionsRequest = overrides.filterOptionsRequest;
  return merged;
}

/**
 * CLI entry point. Returns the process exit code instead of exiting so tests
 * can call it directly.
 */
export async function runCli(argv, options = {}) {
  const stdout = options.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = options.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr(formatError(error));
    stderr("Run digikey-search --help for usage.");
    return 2;
  }

  if (parsed.help) {
    stdout(HELP);
    return 0;
  }

  try {
    const base = parsed.requestFile ? await readRequestFile(parsed.requestFile) : {};
    const input = mergeInput(base, parsed.input);
    if (!input.keywords) {
      throw new DigiKeyInputError("`--keywords` is required unless --request provides keywords.");
    }

    const configOverrides = {
      site: input.site,
      language: input.language,
      currency: input.currency,
    };

    const result = await searchKeyword(input, {
      env,
      fetchImpl,
      signal: options.signal,
      configOverrides,
    });

    if (parsed.raw) {
      stdout(JSON.stringify(result.raw, null, 2));
    } else if (parsed.format === "text") {
      stdout(
        formatSearchText(result.response, {
          includeParameterIds: parsed.showParameterIds,
        }),
      );
    } else {
      stdout(JSON.stringify(result.response, null, 2));
    }
    return 0;
  } catch (error) {
    stderr(formatError(error));
    if (error instanceof DigiKeyConfigError) return 3;
    if (error instanceof DigiKeyInputError) return 2;
    if (error instanceof DigiKeyApiError) {
      return error.status === 401 || error.status === 403 ? 3 : 4;
    }
    return 1;
  }
}
