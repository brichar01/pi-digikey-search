---
name: digikey-part-search
description: Search Digi-Key for electronic components using the iterative KeywordSearch workflow — broad keyword search, read the returned filterOptions, then refine with manufacturer, status, packaging, category, series, and parametric filters. Use when asked to find, compare, source, or shortlist Digi-Key parts by specs such as voltage, interface, sampling rate, package, availability, MOQ, or manufacturer.
---

# Digi-Key part search

Use `digikey_search` for every query. It wraps Digi-Key ProductSearch v4
`POST /products/v4/search/keyword` and returns normalized products plus the
`filterOptions` needed for the next request.

## Ground rules

These are enforced by the tool. Do not try to bypass them, and state them when
they affect the answer.

1. **No marketplace.** Marketplace is always excluded. Do not recommend a
   marketplace listing or suggest enabling it.
2. **No out-of-stock parts.** `InStock` is always requested and the stock
   threshold is at least 1. Report stock quantity; prefer high stock.
3. **No obsolete / discontinued / EOL / last-time-buy parts.** The tool removes
   them locally. If every match is removed, say so and broaden the search.
4. **NRND is kept but must be called out.** "Not For New Designs" parts are
   returned so you can mention them, but flag them with `NRND` in the answer and
   do not present them as a good choice for a new design unless the user
   explicitly accepts the risk.
5. **Low or no MOQ.** Prefer MOQ 1. Report MOQ for every shortlisted part. The
   tool warns above 10 by default; use `maxMoq` when the user needs a hard limit
   (for example a prototype run).

## The repeated search pattern

### 1. Turn the request into a broad first search

Do not stuff every constraint into the keywords. Digi-Key keyword search is a
text match, while specs are usually available as structured filters.

- Good first queries: `ceramic capacitor`, `aluminum electrolytic capacitor`,
  `audio codec`, `SPI ADC`, `buck converter`, or the exact manufacturer part
  number if the user gave one.
- Keep keywords under 250 characters.
- Start with `limit` 10-20 so you can inspect both parts and filters.
- Use `minQuantityAvailable` for "high availability" (for example 100) and
  `sortField: "QuantityAvailable"`, `sortOrder: "Descending"`.
- Use `maxMoq` only after deciding what "low MOQ" means for the request.

Example first call:

```json
{
  "keywords": "audio codec",
  "limit": 20
}
```

### 2. Read the response before searching again

The response contains:

- `products` and `exactMatches`: normalized parts with `status`, `nrnd`,
  `quantityAvailable`, `minimumOrderQuantity`, `unitPrice`, `parameters`,
  `packageTypes`, `productUrl`, `datasheetUrl`, and `warnings`.
- `warnings`: aggregate NRND / high-MOQ / ground-rule-removal notices.
- `filterOptions`: the authoritative IDs for the next request.
  - `manufacturers[]`: `{ id, name, productCount }`
  - `status[]`: `{ id, name, productCount }`
  - `packaging[]`: `{ id, name, productCount }`
  - `series[]`: `{ id, name, productCount }`
  - `topCategories[]`: category IDs and counts (may be empty)
  - `parameters[]`: `{ parameterId, parameterName, parameterType, values[] }`
    with `{ valueId, name, productCount, rangeFilterType }` values; may be empty.
- `productParameterHints`: when `filterOptions.parameters` is empty, candidate
  filters derived from `products[].parameters`, plus child-category IDs for
  `parameterCategoryId`.
- `appliedParametricFilters`: may be empty even when filtering worked.
- `filteredOut`: how many marketplace/out-of-stock/obsolete/high-MOQ parts the
  ground rules removed.
- `apiProductsCount` versus `returnedProductCount`: the API count is before
  local ground-rule filtering.

**Never invent a filter ID, parameter ID, or value ID.** Only use values that
appear in this response.

### 3. Map user constraints to filter options

Find the option by name, case-insensitively, and use its ID.

- **Manufacturer**: match `filterOptions.manufacturers[].name`, including
  aliases (e.g. ADI and ADI/Maxim are separate IDs); pass every match in
  `manufacturerIds`.
- **Status**: use `filterOptions.status[].id` for `statusIds`. Prefer `Active`
  when the user wants parts for a new design. Keep NRND visible if the user is
  repairing an existing design, but call it out.
- **Packaging**: use `filterOptions.packaging[].id` for `packagingIds` (Cut Tape,
  Digi-Reel, Tape & Reel, Tube, Tray, etc.).
- **Category / series**: use `topCategories[].category.categoryId` or
  `filterOptions.series[].id`.
- **Parametric spec**: find the parameter by `parameterName`, then OR all
  `values[].valueId`s whose names match. Values can be compound (`I2C, Serial,
  SPI`); `Serial` alone is ambiguous. If `filterOptions.parameters` is empty,
  use `productParameterHints` instead.

Parametric request shape:

```json
{
  "keywords": "ceramic capacitor",
  "parameterCategoryId": "<category id from filterOptions>",
  "parameters": [
    { "parameterId": 1234, "valueIds": ["<valueId-50V>"] }
  ]
}
```

Multiple `valueIds` are OR-ed; `parameters` are AND-ed and require a
`parameterCategoryId`. Use a **child/leaf category**, never a parent: take it
from `productParameterHints.categories`, `topCategories[].category.categoryId`,
or `product.category.childCategories[].categoryId`. Parent categories fail with
`Parametric Filtering Not Support at Parent Category Level`.

#### Range parameters

`values[].rangeFilterType` is `Min`, `Max`, or `Range` when the parameter is a
range. For "at least 50 V", prefer the discrete 50 V value plus higher values if
the list is small enough; otherwise use the closest matching range value. Do not
fabricate range syntax. If the range options are ambiguous, verify the actual
`parameters` on the returned products (`value` text) and tell the user how you
filtered.

#### When a constraint has no filter option

- Do not assume the spec is searchable; `192kHz audio codec` can match eval
  boards. Filter what the API exposes and verify the rest from product
  parameters or the datasheet.
- Narrow with manufacturer/category/series filters, then inspect. Never claim a
  part meets a spec just because a keyword matched.
- When `filterOptions.parameters` is empty, use `productParameterHints` (or raw
  `products[].parameters`) for candidate `parameterId`/`valueId` pairs, and use
  a child category for `parameterCategoryId`.

### 4. Re-search with the same keywords plus filters

Keep the broad keywords and add IDs. Example:

```json
{
  "keywords": "audio codec",
  "manufacturerIds": ["<TI id>", "<ADI id>"],
  "parameters": [
    { "parameterId": 9876, "valueIds": ["<SPI valueId>"] }
  ],
  "parameterCategoryId": "<audio codec category id>",
  "limit": 20
}
```

Read `filteredOut` and `warnings` again. If too few results:

- Remove the most restrictive parametric filter.
- Use a broader category or fewer `valueIds`.
- Increase `limit` or page with `offset`.
- Lower `minQuantityAvailable`, but never below 1.

If too many results, add another filter from the same response, or use
`maxMoq` for a prototyping constraint.

### 5. Present the shortlist

For each recommended part include:

- Digi-Key part number, manufacturer, manufacturer part number
- description and key parameters that satisfy the request
- `status` (and **NRND** if `nrnd` is true)
- `quantityAvailable`, `minimumOrderQuantity`, price/currency
- package type and product/datasheet links
- any `warnings`

State the ground rules briefly: marketplace excluded, in stock required,
obsolete/EOL removed, NRND called out, MOQ considered.

## Worked examples

### "Find a capacitor with 50 V rating and high availability"

1. `digikey_search({ keywords: "ceramic capacitor", limit: 20 })` — or try
   `aluminum electrolytic capacitor` if that is the likely technology.
2. Read `filterOptions.parameters`, or `productParameterHints` if empty; find the
   voltage parameter (for example `Voltage - Rated`). Use its `parameterId` and
   the `50 V`-or-higher `valueId`s, with a child `parameterCategoryId`.
3. Re-search with `minQuantityAvailable: 100`, `sortField:
   "QuantityAvailable"`, and the voltage parameter filter.
4. Report stock, MOQ, dielectric/package parameters, and any NRND/high-MOQ
   warnings.

### "Find a 192 kHz codec from TI or Analog Devices with an SPI interface"

1. `digikey_search({ keywords: "audio codec", limit: 20 })`.
2. Match all TI and Analog Devices IDs, including ADI/Maxim variants, then
   re-search with every `manufacturerId`.
3. Find `Data Interface` and OR every value containing SPI. Sampling rate is
   usually not returned; verify 192 kHz in the datasheet, not by adding it to
   the keywords.
4. Present only parts verified for SPI and 192 kHz. Call out NRND explicitly.

## Using the CLI / codemode

The same client is available as a CLI:

```bash
digikey-search --keywords "audio codec" --limit 20
digikey-search --keywords "ceramic capacitor" --parameter '14=74515' --parameter-category 60
digikey-search --keywords "ceramic capacitor" --format text --show-parameter-ids
```

From a codemode script, `digikey_search` returns the full normalized object, so
you can inspect every filter value rather than the compact text summary:

```js
const first = await tools.digikey_search({ keywords: "audio codec", limit: 20 });
const candidates = first.filterOptions.parameters.length > 0
  ? first.filterOptions.parameters
  : first.productParameterHints.parameters;
const voltage = candidates.find((p) => /voltage/i.test(p.parameterName));
const ti = first.filterOptions.manufacturers.find((m) => /Texas Instruments/i.test(m.name));
const refined = await tools.digikey_search({
  keywords: "audio codec",
  manufacturerIds: [ti.id],
  parameters: [{ parameterId: voltage.parameterId, valueIds: [voltage.values[0].valueId] }],
  parameterCategoryId: first.productParameterHints.categories[0]?.id
    ?? first.filterOptions.topCategories[0]?.category?.categoryId,
});
return refined.products;
```

## Errors from KeywordSearch

The API returns `DKProblemDetails` with `type`, `title`, `status`, `detail`,
`instance`, `correlationId`, and `errors` (field → messages). The tool prints the
status, detail, field errors, correlation ID, and a hint.

| Status | Meaning | What to do |
|---|---|---|
| 400 | Bad Request — input model invalid or malformed | Check keywords length (≤250), limit (1–50), offset, filter IDs, and that parametric filters include `parameterCategoryId`. |
| 401 | Unauthorized — token expired, or Client Id/subscription invalid | Check `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET`, the app's Product Information v4 subscription, and sandbox vs production credentials. |
| 403 | Forbidden | The app lacks access to the API/locale/resource. Do not retry blindly. |
| 404 | Not Found | Check the endpoint/resource. KeywordSearch itself should not normally return this. |
| 429 | Too Many Requests — rate limit exceeded | Back off, honor `Retry-After`, reuse previous results/filters, and do not loop. |
| 500 | Unhandled server error | Retry later; include `correlationId` if reporting. |
| 503 | Service Unavailable | Retry later with backoff. |

Also handle:

- **OAuth token errors** (`invalid_client`, `invalid_grant`,
  `unauthorized_client`) — credentials/environment problem, exit code 3.
- **Network timeout / connection failure** — check connectivity, raise
  `DIGIKEY_TIMEOUT_MS`, then retry.
- **Non-JSON success response** — treat as an API/network failure; do not parse
  it as products.

## Pitfalls

- Do not page through hundreds of results before reading filters. One broad
  search plus one refined search is usually better.
- Do not use `filterOptions` IDs from a different keyword search; IDs are tied to
  the returned category/parameter context.
- Do not hide NRND. Put it in the part row and mention it in prose.
- Do not recommend a marketplace or out-of-stock alternative. The ground rules
  forbid it.
- KeywordSearch returns StandardPricing only. Do not claim MyPricing or
  account-specific pricing from this endpoint.
- Local ground-rule filtering can make `returnedProductCount` smaller than
  `apiProductsCount`; explain that when the user asks why results are missing.
