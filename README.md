# Digi-Key ProductSearch for pi

A small, dependency-free Digi-Key ProductSearch v4 client, CLI, and pi
extension. It implements the repeated keyword-search workflow:

1. Search broadly by keyword.
2. Read the `filterOptions` Digi-Key returns.
3. Re-search with manufacturer/status/packaging/category/series/parametric
   filter IDs from that response.
4. Repeat until the shortlist is small enough.

The companion skill, `digikey-part-search`, teaches the model that loop and sets
the ground rules below.

## Ground rules

- **No marketplace.** Every search forces
  `MarketPlaceFilter: "ExcludeMarketPlace"`.
- **No out-of-stock parts.** Every search requests `InStock` and a minimum
  available quantity of at least 1, then verifies stock locally.
- **No obsolete / discontinued / EOL / last-time-buy parts.** These are removed
  from the normalized results.
- **NRND is kept and flagged.** "Not For New Designs" parts are returned with
  `nrnd: true`, product warnings, and an aggregate warning so the agent must
  call them out.
- **Low or no MOQ.** Every product reports `minimumOrderQuantity`. MOQ above 10
  is warned by default. Use `maxMoq` for a hard limit.

KeywordSearch returns **StandardPricing only**; MyPricing is not available from
this endpoint.

## Install

```bash
./install.sh
```

This symlinks the checkout into:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/digikey-product-search
```

The extension advertises its bundled skill at runtime, so the skill is available
without a separate install. It also installs the CLI:

```text
${PREFIX:-$HOME/.local/bin}/digikey-search
```

Options:

```bash
./install.sh --help
./install.sh --agent-dir /path/to/agent --bin-dir /path/to/bin
./install.sh --uninstall
```

After installing, reload pi with `/reload` (or restart it).

You can also install the directory as a pi package:

```bash
pi install /path/to/digikey-product-search
```

## Credentials

The client reads secrets only from the environment:

```bash
export DIGIKEY_CLIENT_ID="..."
export DIGIKEY_CLIENT_SECRET="..."
```

Optional variables:

| Variable | Default | Purpose |
|---|---|---|
| `DIGIKEY_ACCOUNT_ID` | unset | Account ID for endpoints that support MyPricing; not used by KeywordSearch |
| `DIGIKEY_SITE` | `US` | Locale site (`US`, `UK`, `DE`, …) |
| `DIGIKEY_LANGUAGE` | `en` | Locale language |
| `DIGIKEY_CURRENCY` | `USD` | Pricing currency |
| `DIGIKEY_SANDBOX` | off | `1`/`true` selects `sandbox-api.digikey.com` |
| `DIGIKEY_API_HOST` | off | Explicit host override |
| `DIGIKEY_TIMEOUT_MS` | `30000` | Request timeout |

Get credentials and subscribe the app to the **Product Information v4** API at
<https://developer.digikey.com>.

## CLI

```bash
digikey-search --keywords "ceramic capacitor" --limit 10 --format text
digikey-search --keywords "audio codec" --min-qty 100 --sort QuantityAvailable
digikey-search --keywords "audio codec" --manufacturer-id 296 --limit 20
digikey-search --keywords "ceramic capacitor" --parameter '14=74515' --parameter-category 60
digikey-search --keywords "ceramic capacitor" --format text --show-parameter-ids
digikey-search --request request.json
digikey-search --help
```

The default output is normalized JSON. `--format text` prints the same readable
summary the pi tool uses. `--show-parameter-ids` adds `parameterId`/`valueId` to
each product's text `params:` line. `--raw` prints the unmodified Digi-Key
response.

When Digi-Key returns no `filterOptions.parameters` (common for broad keyword
searches), the normalized response includes `productParameterHints` derived from
`products[].parameters`. They use the same parameter/value ID namespace as the
website filters. Use a **child category**, not a parent category, for
`parameterCategoryId`; parent categories are rejected by the API. Product
`category.childCategories` exposes those child IDs.

`--request` reads a JSON input object, for example:

```json
{
  "keywords": "audio codec",
  "limit": 20,
  "manufacturerIds": ["296", "584"],
  "parameters": [
    { "parameterId": 1234, "valueIds": ["5678"] }
  ],
  "parameterCategoryId": "52",
  "minQuantityAvailable": 100,
  "maxMoq": 10,
  "sortField": "QuantityAvailable",
  "sortOrder": "Descending"
}
```

Filter IDs must come from a previous response. Never invent them.

## pi tool

The extension registers `digikey_search`. It is a normal direct tool and is also
callable from codemode as `tools.digikey_search(...)`.

```json
{
  "keywords": "audio codec",
  "limit": 20,
  "manufacturerIds": ["<id from filterOptions.manufacturers>"],
  "parameters": [
    { "parameterId": 1234, "valueIds": ["<id from filterOptions.parameters[].values>"] }
  ],
  "parameterCategoryId": "<category id>"
}
```

The tool returns:

- `products` / `exactMatches` — normalized parts with status, NRND, stock, MOQ,
  price, parameters, package types, URLs, and warnings
- `filterOptions` — manufacturers, statuses, packaging, series, categories, and
  parametric filters with the IDs for the next request
- `productParameterHints` — fallback parameter/value IDs derived from returned
  products when `filterOptions.parameters` is empty, including child-category
  candidates for `parameterCategoryId`
- `appliedParametricFilters`
- `filteredOut` — counts of marketplace/out-of-stock/obsolete/high-MOQ parts
  removed locally
- `warnings` — aggregate NRND, MOQ, and ground-rule notices

The text output is a compact summary. It prints product-derived filter hints
when Digi-Key does not return parametric filter options. Pass
`showParameterIds: true` to include parameter/value IDs on each product's text
`params:` line. The full structured object is returned in `structuredContent`,
so codemode scripts can search every filter value without raising display
limits.

### Codemode example

```js
const first = await tools.digikey_search({ keywords: "audio codec", limit: 20 });
const voltage = first.filterOptions.parameters.find((p) => /voltage/i.test(p.parameterName));
const ti = first.filterOptions.manufacturers.find((m) => /Texas Instruments/i.test(m.name));
const refined = await tools.digikey_search({
  keywords: "audio codec",
  manufacturerIds: [ti.id],
  parameters: [{ parameterId: voltage.parameterId, valueIds: [voltage.values[0].valueId] }],
  parameterCategoryId: first.filterOptions.topCategories[0]?.category?.categoryId,
});
return refined.products;
```

## Skill

`skills/digikey-part-search/SKILL.md` describes:

- the initial-search → read-filter-options → add-parameters loop
- how to map manufacturer/status/packaging/category/series/parametric constraints
- how to handle range filters and missing filter values
- the ground rules and NRND/MOQ reporting requirements
- the `DKProblemDetails` errors returned by KeywordSearch
- worked examples: a 50 V high-availability capacitor and a 192 kHz SPI codec
  from TI or Analog Devices

Load it explicitly with `/skill:digikey-part-search`, or let pi select it for a
multi-constraint part request.

## Errors

KeywordSearch returns `DKProblemDetails`:

```json
{
  "type": "...",
  "title": "...",
  "status": 400,
  "detail": "...",
  "instance": "...",
  "correlationId": "...",
  "errors": { "Field": ["message"] }
}
```

| Status | Meaning | Handling |
|---|---|---|
| 400 | Bad Request — invalid/malformed input | Check keywords length, limit 1-50, offset, and filter IDs from a previous response |
| 401 | Unauthorized — expired token or invalid Client Id/subscription | Check env credentials, v4 subscription, sandbox vs production |
| 403 | Forbidden | App lacks access to the API/locale/resource |
| 404 | Not Found | Check endpoint/resource |
| 429 | Too Many Requests | Honor `Retry-After`, back off, reuse previous results |
| 500 | Unhandled server error | Retry later; report `correlationId` |
| 503 | Service Unavailable | Retry with backoff |

The client also reports OAuth token errors (`invalid_client`, `invalid_grant`,
`unauthorized_client`), network timeouts, connection failures, and invalid JSON
success responses.

CLI exit codes: `0` success, `2` usage/input, `3` configuration/auth, `4`
API/network.

## Development

```bash
npm test
npm run check
./install.sh --agent-dir /tmp/pi-agent --bin-dir /tmp/pi-bin
```

Tests use a mocked `fetch`; no API credentials or network access are required.

## Layout

```text
lib/digikey.mjs        shared client, normalizer, CLI
bin/digikey-search     executable CLI
extensions/digikey.ts  pi tool registration
index.ts               extension entry point for symlinked installs
skills/                digikey-part-search skill
install.sh             extension + CLI installer
test/                  node:test tests with mocked fetch
```
