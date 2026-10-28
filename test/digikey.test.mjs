import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  DigiKeyApiError,
  DigiKeyConfigError,
  DigiKeyInputError,
  buildKeywordRequest,
  clearTokenCache,
  formatSearchText,
  resolveConfig,
  runCli,
  searchKeyword,
} from "../lib/digikey.mjs";

const ENV = {
  DIGIKEY_CLIENT_ID: "client-id",
  DIGIKEY_CLIENT_SECRET: "client-secret",
  DIGIKEY_SITE: "US",
  DIGIKEY_LANGUAGE: "en",
  DIGIKEY_CURRENCY: "USD",
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function product(overrides = {}) {
  return {
    Description: {
      ProductDescription: "Stereo audio codec, 192 kHz, SPI",
      DetailedDescription: "Stereo audio codec with SPI control",
    },
    Manufacturer: { Id: 296, Name: "Texas Instruments" },
    ManufacturerProductNumber: "PCM1860",
    UnitPrice: 4.2,
    ProductUrl: "https://www.digikey.com/product-detail/example",
    DatasheetUrl: "https://example.com/datasheet.pdf",
    PhotoUrl: null,
    QuantityAvailable: 1000,
    ProductStatus: { Id: 1, Status: "Active" },
    Category: {
      CategoryId: 3,
      ParentId: 0,
      Name: "Capacitors",
      ProductCount: 0,
      ChildCategories: [
        {
          CategoryId: 60,
          ParentId: 3,
          Name: "Ceramic Capacitors",
          ProductCount: 0,
          ChildCategories: [],
        },
      ],
    },
    ProductVariations: [
      {
        DigiKeyProductNumber: "296-1234-ND",
        PackageType: { Id: 1, Name: "Cut Tape" },
        StandardPricing: [{ BreakQuantity: 1, UnitPrice: 4.2, TotalPrice: 4.2 }],
        MyPricing: [],
        MarketPlace: false,
        QuantityAvailableforPackageType: 1000,
        MinimumOrderQuantity: 1,
      },
    ],
    Parameters: [
      {
        ParameterId: 42,
        ParameterText: "Interface",
        ParameterType: "String",
        ValueId: "10",
        ValueText: "SPI",
      },
      {
        ParameterId: 43,
        ParameterText: "Voltage - Rated",
        ParameterType: "UnitOfMeasure",
        ValueId: "50",
        ValueText: "50 V",
      },
    ],
    ...overrides,
  };
}

function keywordResponse(products = [product()], overrides = {}) {
  return {
    ProductsCount: products.length,
    Products: products,
    ExactMatches: [],
    FilterOptions: {
      Manufacturers: [
        { Id: 296, Value: "Texas Instruments", ProductCount: 30 },
        { Id: 584, Value: "Analog Devices Inc.", ProductCount: 20 },
      ],
      Packaging: [{ Id: 1, Value: "Cut Tape", ProductCount: 100 }],
      Status: [
        { Id: 1, Value: "Active", ProductCount: 100 },
        { Id: 2, Value: "Not For New Designs", ProductCount: 5 },
      ],
      Series: [{ Id: 10, Value: "PCM", ProductCount: 10 }],
      ParametricFilters: [
        {
          Category: { Id: 52, Value: "Audio Codecs", ProductCount: 50 },
          ParameterType: "String",
          ParameterId: 42,
          ParameterName: "Interface",
          FilterValues: [
            { ProductCount: 20, ValueId: "10", ValueName: "SPI", RangeFilterType: null },
          ],
        },
        {
          Category: { Id: 52, Value: "Audio Codecs", ProductCount: 50 },
          ParameterType: "UnitOfMeasure",
          ParameterId: 43,
          ParameterName: "Voltage - Rated",
          FilterValues: [
            { ProductCount: 10, ValueId: "50", ValueName: "50 V", RangeFilterType: "Min" },
          ],
        },
      ],
      TopCategories: [
        {
          RootCategory: { Id: 1, Name: "Integrated Circuits", ProductCount: 500 },
          Category: { Id: 52, Name: "Audio Codecs", ProductCount: 50 },
          Score: 1,
          ImageUrl: null,
        },
      ],
      MarketPlaceFilters: ["NoFilter", "ExcludeMarketPlace", "MarketPlaceOnly"],
    },
    SearchLocaleUsed: { Site: "US", Language: "en", Currency: "USD" },
    AppliedParametricFiltersDto: [{ Id: 42, Text: "Interface: SPI", Priority: 1 }],
    ...overrides,
  };
}

function makeFetch({ searchResponse = keywordResponse(), searchStatus = 200, searchHeaders = {}, tokenStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/v1/oauth2/token")) {
      if (tokenStatus !== 200) {
        return jsonResponse(
          { error: "invalid_client", error_description: "Invalid client credentials" },
          { status: tokenStatus },
        );
      }
      return jsonResponse({ access_token: "test-token", token_type: "Bearer", expires_in: 600 });
    }
    return jsonResponse(searchResponse, { status: searchStatus, headers: searchHeaders });
  };
  return { calls, fetchImpl };
}

describe("configuration", () => {
  beforeEach(() => clearTokenCache());

  test("requires client id and secret", () => {
    assert.throws(() => resolveConfig({}, {}), DigiKeyConfigError);
    try {
      resolveConfig({}, {});
    } catch (error) {
      assert.deepEqual(error.missing, ["DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET"]);
    }
  });

  test("normalizes locale and sandbox", () => {
    const config = resolveConfig(
      {},
      { ...ENV, DIGIKEY_SITE: "de", DIGIKEY_LANGUAGE: "EN", DIGIKEY_CURRENCY: "eur", DIGIKEY_SANDBOX: "true" },
    );
    assert.equal(config.site, "DE");
    assert.equal(config.language, "en");
    assert.equal(config.currency, "EUR");
    assert.equal(config.host, "sandbox-api.digikey.com");
  });
});

describe("request construction", () => {
  beforeEach(() => clearTokenCache());

  test("forces ground rules and keeps caller filters", async () => {
    const { calls, fetchImpl } = makeFetch();
    const result = await searchKeyword(
      {
        keywords: "  audio codec  ",
        limit: 999,
        offset: -3,
        manufacturerIds: ["296"],
        statusIds: ["2"],
        parameters: [{ parameterId: 42, valueIds: ["10"] }],
        parameterCategoryId: "52",
        minQuantityAvailable: 0,
        sortField: "QuantityAvailable",
      },
      { env: ENV, fetchImpl },
    );

    assert.equal(calls.length, 2);
    const searchCall = calls[1];
    assert.match(searchCall.url, /\/products\/v4\/search\/keyword$/);
    assert.equal(searchCall.init.headers.Authorization, "Bearer test-token");
    assert.equal(searchCall.init.headers["X-DIGIKEY-Client-Id"], "client-id");
    assert.equal(searchCall.init.headers["X-DIGIKEY-Locale-Site"], "US");

    const body = JSON.parse(searchCall.init.body);
    assert.equal(body.Keywords, "audio codec");
    assert.equal(body.Limit, 50);
    assert.equal(body.Offset, 0);
    assert.equal(body.FilterOptionsRequest.MarketPlaceFilter, "ExcludeMarketPlace");
    assert.deepEqual(body.FilterOptionsRequest.SearchOptions, ["InStock"]);
    assert.equal(body.FilterOptionsRequest.MinimumQuantityAvailable, 1);
    assert.deepEqual(body.FilterOptionsRequest.ManufacturerFilter, [{ Id: "296" }]);
    assert.deepEqual(body.FilterOptionsRequest.StatusFilter, [{ Id: "2" }]);
    assert.deepEqual(body.FilterOptionsRequest.ParameterFilterRequest, {
      ParameterFilters: [{ ParameterId: 42, FilterValues: [{ Id: "10" }] }],
      CategoryFilter: { Id: "52" },
    });
    assert.deepEqual(body.SortOptions, { Field: "QuantityAvailable", SortOrder: "Descending" });
    assert.equal(result.response.query, "audio codec");
  });

  test("rejects invalid keywords and input IDs", () => {
    assert.throws(() => buildKeywordRequest({}), DigiKeyInputError);
    assert.throws(() => buildKeywordRequest({ keywords: "x".repeat(251) }), DigiKeyInputError);
    assert.throws(
      () => buildKeywordRequest({ keywords: "codec", parameters: [{ parameterId: 42, valueIds: [] }] }),
      DigiKeyInputError,
    );
  });

  test("caches the OAuth token across searches", async () => {
    const { calls, fetchImpl } = makeFetch();
    await searchKeyword({ keywords: "codec" }, { env: ENV, fetchImpl });
    await searchKeyword({ keywords: "codec" }, { env: ENV, fetchImpl });
    const tokenCalls = calls.filter((call) => call.url.includes("/v1/oauth2/token"));
    assert.equal(tokenCalls.length, 1);
    assert.equal(calls.length, 3);
  });
});

describe("normalization and ground rules", () => {
  beforeEach(() => clearTokenCache());

  test("removes marketplace, out-of-stock, and obsolete parts; flags NRND and MOQ", async () => {
    const nrnd = product({
      ManufacturerProductNumber: "NRND-1",
      ProductStatus: { Id: 2, Status: "Not For New Designs" },
      ProductVariations: [
        {
          DigiKeyProductNumber: "NRND-1-ND",
          PackageType: { Id: 1, Name: "Cut Tape" },
          StandardPricing: [{ BreakQuantity: 1, UnitPrice: 2, TotalPrice: 2 }],
          MarketPlace: false,
          QuantityAvailableforPackageType: 50,
          MinimumOrderQuantity: 25,
        },
      ],
    });
    const obsolete = product({
      ManufacturerProductNumber: "OLD-1",
      ProductStatus: { Id: 3, Status: "Obsolete" },
    });
    const outOfStock = product({
      ManufacturerProductNumber: "OOS-1",
      QuantityAvailable: 0,
      ProductVariations: [
        {
          DigiKeyProductNumber: "OOS-1-ND",
          PackageType: { Id: 1, Name: "Cut Tape" },
          MarketPlace: false,
          QuantityAvailableforPackageType: 0,
          MinimumOrderQuantity: 1,
        },
      ],
    });
    const marketplace = product({
      ManufacturerProductNumber: "MKT-1",
      ProductVariations: [
        {
          DigiKeyProductNumber: "MKT-1-ND",
          PackageType: { Id: 1, Name: "Cut Tape" },
          MarketPlace: true,
          QuantityAvailableforPackageType: 500,
          MinimumOrderQuantity: 1,
        },
      ],
    });

    const { fetchImpl } = makeFetch({
      searchResponse: keywordResponse([product(), nrnd, obsolete, outOfStock, marketplace]),
    });
    const result = await searchKeyword({ keywords: "codec" }, { env: ENV, fetchImpl });

    assert.equal(result.response.products.length, 2);
    assert.equal(result.response.products[0].manufacturerPartNumber, "PCM1860");
    assert.equal(result.response.products[1].manufacturerPartNumber, "NRND-1");
    assert.equal(result.response.products[1].nrnd, true);
    assert.equal(result.response.products[1].minimumOrderQuantity, 25);
    assert.match(result.response.products[1].warnings.join(" "), /NRND/);
    assert.match(result.response.products[1].warnings.join(" "), /High MOQ/);
    assert.deepEqual(result.response.filteredOut, {
      marketplace: 1,
      outOfStock: 1,
      obsolete: 1,
      highMoq: 0,
      malformed: 0,
    });
    assert.ok(result.response.warnings.some((warning) => /NRND/.test(warning)));
    assert.ok(result.response.warnings.some((warning) => /MOQ/.test(warning)));
  });

  test("applies optional maxMoq hard filter", async () => {
    const highMoq = product({
      ManufacturerProductNumber: "HIGH-MOQ",
      ProductVariations: [
        {
          DigiKeyProductNumber: "HIGH-MOQ-ND",
          PackageType: { Id: 1, Name: "Reel" },
          StandardPricing: [{ BreakQuantity: 100, UnitPrice: 1, TotalPrice: 100 }],
          MarketPlace: false,
          QuantityAvailableforPackageType: 1000,
          MinimumOrderQuantity: 100,
        },
      ],
    });
    const { fetchImpl } = makeFetch({ searchResponse: keywordResponse([product(), highMoq]) });
    const result = await searchKeyword(
      { keywords: "codec", maxMoq: 10 },
      { env: ENV, fetchImpl },
    );
    assert.equal(result.response.products.length, 1);
    assert.equal(result.response.filteredOut.highMoq, 1);
    assert.ok(result.response.warnings.some((warning) => /maxMoq=10/.test(warning)));
  });

  test("normalizes filter options and formats IDs for the model", async () => {
    const { fetchImpl } = makeFetch();
    const result = await searchKeyword({ keywords: "codec" }, { env: ENV, fetchImpl });
    const filters = result.response.filterOptions;
    assert.equal(filters.manufacturers[0].id, "296");
    assert.equal(filters.parameters[0].parameterId, 42);
    assert.equal(filters.parameters[0].values[0].valueId, "10");
    assert.equal(filters.parameters[1].values[0].rangeFilterType, "Min");

    const text = formatSearchText(result.response);
    assert.match(text, /Texas Instruments \(id=296/);
    assert.match(text, /Voltage - Rated \[parameterId=43\]/);
    assert.match(text, /50 V \(id=50/);
    assert.match(text, /Applied parametric filters: Interface: SPI/);
    assert.equal(result.response.productParameterHints.parameters.length, 0);
  });

  test("preserves child categories and derives product parameter hints when needed", async () => {
    const base = keywordResponse();
    const responseWithoutParametricFilters = keywordResponse([product()], {
      FilterOptions: {
        ...base.FilterOptions,
        ParametricFilters: [],
        TopCategories: [],
      },
    });
    const { fetchImpl } = makeFetch({ searchResponse: responseWithoutParametricFilters });
    const result = await searchKeyword({ keywords: "ceramic capacitor" }, { env: ENV, fetchImpl });

    assert.equal(result.response.products[0].category.categoryId, 3);
    assert.equal(result.response.products[0].category.childCategories[0].categoryId, 60);
    assert.equal(result.response.products[0].category.childCategories[0].name, "Ceramic Capacitors");

    const hints = result.response.productParameterHints;
    assert.match(hints.reason, /filterOptions\.parameters was empty/);
    assert.deepEqual(hints.categories, [
      { id: "60", name: "Ceramic Capacitors", productCount: 1 },
    ]);

    const interfaceHint = hints.parameters.find((parameter) => parameter.parameterId === 42);
    assert.equal(interfaceHint.parameterName, "Interface");
    assert.equal(interfaceHint.parameterType, "String");
    assert.deepEqual(interfaceHint.categoryIds, ["60"]);
    assert.deepEqual(interfaceHint.values, [
      {
        valueId: "10",
        name: "SPI",
        productCount: 1,
        categoryIds: ["60"],
      },
    ]);

    const text = formatSearchText(result.response);
    assert.match(text, /Product-derived parametric filter hints/);
    assert.match(text, /parameterCategoryId candidates: Ceramic Capacitors \(id=60, count=1\)/);
    assert.match(text, /Interface \[parameterId=42\]/);
    assert.match(text, /SPI \(id=10, count=1\)/);

    const textWithIds = formatSearchText(result.response, { includeParameterIds: true });
    assert.match(textWithIds, /Interface=SPI \[parameterId=42, valueId=10\]/);
  });
});

describe("errors", () => {
  beforeEach(() => clearTokenCache());

  test("formats DKProblemDetails and Retry-After for 429", async () => {
    const problem = {
      type: "https://tools.ietf.org/html/rfc7231#section-6.5.29",
      title: "Too Many Requests",
      status: 429,
      detail: "Rate limit exceeded for this subscription.",
      instance: "/products/v4/search/keyword",
      correlationId: "corr-123",
      errors: { Keywords: ["Too many requests"] },
    };
    const { fetchImpl } = makeFetch({
      searchStatus: 429,
      searchHeaders: { "retry-after": "7" },
      searchResponse: problem,
    });

    await assert.rejects(
      () => searchKeyword({ keywords: "codec" }, { env: ENV, fetchImpl }),
      (error) => {
        assert.ok(error instanceof DigiKeyApiError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfter, 7);
        assert.equal(error.correlationId, "corr-123");
        assert.match(error.message, /HTTP 429 Too Many Requests/);
        assert.match(error.message, /Rate limit exceeded/);
        assert.match(error.message, /retryAfter: 7 second/);
        assert.match(error.message, /hint: Back off/);
        return true;
      },
    );
  });

  test("reports OAuth token errors without leaking the secret", async () => {
    const { fetchImpl } = makeFetch({ tokenStatus: 401 });
    await assert.rejects(
      () => searchKeyword({ keywords: "codec" }, { env: ENV, fetchImpl }),
      (error) => {
        assert.ok(error instanceof DigiKeyApiError);
        assert.equal(error.status, 401);
        assert.match(error.message, /invalid_client/);
        assert.doesNotMatch(error.message, /client-secret/);
        return true;
      },
    );
  });
});

describe("CLI", () => {
  beforeEach(() => clearTokenCache());

  test("prints normalized JSON and applies defaults", async () => {
    const { calls, fetchImpl } = makeFetch();
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      ["--keywords", "codec", "--limit", "5", "--manufacturer-id", "296"],
      {
        env: ENV,
        fetchImpl,
        stdout: (text) => {
          stdout += `${text}\n`;
        },
        stderr: (text) => {
          stderr += `${text}\n`;
        },
      },
    );

    assert.equal(code, 0, stderr);
    const output = JSON.parse(stdout);
    assert.equal(output.returnedProductCount, 1);
    assert.equal(output.filteredOut.marketplace, 0);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.Limit, 5);
    assert.equal(body.FilterOptionsRequest.MarketPlaceFilter, "ExcludeMarketPlace");
  });

  test("text output can include product parameter IDs and derived hints", async () => {
    const base = keywordResponse();
    const { fetchImpl } = makeFetch({
      searchResponse: keywordResponse([product()], {
        FilterOptions: {
          ...base.FilterOptions,
          ParametricFilters: [],
        },
      }),
    });
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      ["--keywords", "codec", "--format", "text", "--show-parameter-ids"],
      {
        env: ENV,
        fetchImpl,
        stdout: (text) => {
          stdout += `${text}\n`;
        },
        stderr: (text) => {
          stderr += `${text}\n`;
        },
      },
    );

    assert.equal(code, 0, stderr);
    assert.match(stdout, /Product-derived parametric filter hints/);
    assert.match(stdout, /Interface=SPI \[parameterId=42, valueId=10\]/);
    assert.match(stdout, /parameterCategoryId candidates: Ceramic Capacitors \(id=60/);
  });

  test("returns usage error without keywords", async () => {
    let stderr = "";
    const code = await runCli([], {
      env: ENV,
      fetchImpl: makeFetch().fetchImpl,
      stdout: () => {},
      stderr: (text) => {
        stderr += `${text}\n`;
      },
    });
    assert.equal(code, 2);
    assert.match(stderr, /keywords/);
  });
});
