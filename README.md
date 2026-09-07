# dsh-model-pricing

A **self-hosted model pricing mirror** for the dsh-tokbook token ledger, with an
explicit **per-provider (billing-channel) dimension** — the same model can bill
differently through different channels (a metered API vs. a subscription that
does not meter tokens per call).

The repo keeps two layers separate:

| File | Layer | Shape | Consumer |
|---|---|---|---|
| `model_pricing.json` | **Model base table** (RMB / per-million-token) | Identical to the maintained upstream feed (`modelId` + 4 rates + time rules / context tiers / peak slots + aliases) | Existing model-only consumers keep working unchanged |
| `provider_pricing.json` | **Per-provider override layer** | `providers[]` → `entries[]` (`model`, `billing: metered\|subscription`, optional `rate`) | The (provider, model) keyed pricing path of dsh-tokbook |

`BASE_SOURCE.json` records provenance of the current base table (which local
mirror it was extracted from, upstream version/updatedAt, built-at).

## Why two layers

- The **base table is a copy of the maintained community feed** (the same one
  tokbook already syncs), so this repo starts from real, auditable model rates
  and stays drop-in for consumers that only know model ids.
- The **provider layer is the part upstream does not have**. A provider route in
  the ledger (e.g. `opencode-go`, `commandcode`) may:
  - bill **metered** — per-million-token, either at the base rate or at a
    channel-specific `rate` (a reseller/relay adds its own margin); or
  - be **subscription** — the model is included in a plan and its calls are not
    charged per token, so the ledger should not bill them at a made-up rate.

A record priced as `(provider, model)` is resolved provider-first, falling back
to the model base table when the provider has no entry.

## Layout

```
model_pricing.json          generated — base table (verbatim from a local mirror)
provider_pricing.json       generated — provider override layer (from source)
providers.source.json       hand-edited — the per-channel FACT list (edit this)
provider_pricing.schema.json            — schema of the provider layer
scripts/build.mjs           generator: base table copy + provider layer compile
BASE_SOURCE.json            provenance of the current base table
```

## Maintain

All pricing-fact editing happens in **`providers.source.json`** (channel list:
which `(provider, model)` is metered/subscription, and any channel-specific
rate). Rebuild artifacts with:

```sh
node scripts/build.mjs                     # uses $DSH_HOME/tokbook/pricing.ccsa.json
node scripts/build.mjs /path/to/pricing.ccsa.json   # or an explicit mirror
```

The base table is refreshed only by re-running against a newer synced mirror —
this script never invents model rates and never fetches the network.

## Schema

- `model_pricing.json`: see the upstream feed schema (README of
  LaoYueHanNi/model-price-table). All amounts RMB per million tokens.
- `provider_pricing.json`: see `provider_pricing.schema.json`. Core rules:
  - `providers[].provider` matches the provider route key **as recorded in the
    ledger** (`deepseek-official`, `opencode-go`, `commandcode`, `zai`,
    `staryears`, `dots-ai`, `modlens-commandcode`, …).
  - `entries[].model` is the **exact model string as recorded** under that
    provider — which may carry a provider prefix (e.g.
    `deepseek/deepseek-v4-flash`) that the base table alone cannot match.
  - `billing: metered` + no `rate` → inherit the base table rates.
  - `billing: metered` + `rate` → override the base table for this channel.
  - `billing: subscription` → no per-token charge to record (a subscription
    plan, or the model is included in the channel's plan).

## Pointing dsh-tokbook at this mirror

Until dsh-tokbook resolves provider-first, you can already point its model-level
sync at this repo's base table (or at the provider layer once the consumer
supports it) via the plugin config:

```yml
plugins:
  tokbook:
    pricingUrl: https://raw.githubusercontent.com/<you>/dsh-model-pricing/master/model_pricing.json
    # pricingRegion: domestic   # or a self-hosted gitee raw URL
```

## Status

- [x] Repo + two-layer structure, schema, generator, provenance
- [x] Base table extracted verbatim from the current synced mirror (169 models)
- [x] Provider layer seeded with the ledger's real `(provider, model)` combos
- [ ] Channel rates/billing confirmed against each provider's terms
  (metered-vs-subscription + any channel-specific price is a FACT to be
  verified per channel, never invented here)
- [ ] dsh-tokbook consumer resolves `(provider, model)` provider-first
