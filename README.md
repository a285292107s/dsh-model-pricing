# dsh-model-pricing

A **self-hosted model pricing mirror** for the dsh-tokbook token ledger, with an
explicit **per-provider (billing-channel) dimension** — the same model can bill
differently through different channels (a metered API vs. a subscription that
does not meter tokens per call).

The repo keeps two layers separate:

| File | Layer | Shape | Consumer |
|---|---|---|---|
| `model_pricing.json` | **Model base table** (RMB / per-million-token) | Identical to the maintained upstream feed (`modelId` + 4 rates + time rules / context tiers / peak slots + aliases) | Existing model-only consumers keep working unchanged |
| `provider_pricing.json` | **Per-provider override layer** | `providers[]` (`provider`, `billing: metered\|subscription`, `entries[]`) → entries (`model`, `inheritBase` \| `segments`) | The (provider, model) keyed pricing path of dsh-tokbook |

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

### Time dimension — prices change

Both layers carry a **time dimension**. The base table's per-model entry already
includes the vendor's own price history as `timeRules` (e.g. `deepseek-v4-flash`
has 原价 → 每日峰谷 segments; `glm-5.3-flash` has a 限时5折 window). The provider
layer resolves each entry to one of two mechanisms:

- **`inheritBase: <modelId>`** — the channel follows the base model's FULL price
  history (every past and current time rule, context tier, peak slot). Official
  channels, subscription channels valued at official prices, and relay
  placeholders all use this, so **when a vendor changes a price you update the
  base table once and every inheriting channel re-prices its history correctly**.
- **`segments[]`** — the channel has its OWN price timeline (a relay's real
  prices once the user fills them in, or a hand-priced unknown model). Each
  segment is `{ from?, to?, rate, note? }`; segments tile the full timeline, the
  first defaults to `from: 0`, the last should be open-ended.

### Billing classes — keep them apart when summing

Billing is a property of the **channel**, so `providers[].billing` carries it and
applies to every entry of that channel; an entry may override it for a mixed
channel:

- **`metered`** — a REAL per-token spend: an official/relay API that actually
  charges. Summing `metered` rows gives actual out-of-pocket spend.
- **`subscription`** — the model is included in a plan; calls are not charged
  per token. Its effective value equals what those calls would cost at the
  official/metered rate — **not actual spend**. A consumer MUST NOT mix
  `subscription` rows into an actual-spend total; report them as subscription
  value instead.

Four source conventions the build resolves automatically:

1. **Official/direct channels** (`deepseek-official`, `zai`, …) — `metered` +
   `inheritBase`: real spend at the official price, following its history.
2. **Relay/reseller channels** (`staryears`, …) — `metered`, currently
   `inheritBase` with `placeholder: true` (a placeholder at the official
   price). To set the relay's REAL price history, replace `inheritBase` with
   `segments[]` (each segment carries the relay's own rate).
3. **Subscription channels** (`opencode-go`, `commandcode`, …) — `subscription`
   + `inheritBase`: the value they create is the official price (following its
   history), never actual spend.
4. **Unknown model strings** (e.g. `dots3-note-prev`) — get **no entry at all**.
   The consumer then reports the string as *unpriced* (¥0, listed in its
   `unpricedModels`), which is honest about not knowing the price; a ¥0
   `segments` entry would instead look like a free model. Add the channel entry
   (with `segments`) once a real price timeline is known.

## Layout

```
model_pricing.json          generated — base table (verbatim from a local mirror;
                            carries each model's timeRules price history)
provider_pricing.json       generated — provider layer (channel billing + per-entry
                            inheritBase or an explicit segments timeline)
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
this script never invents model rates and never fetches the network. A rebuild
with no source change leaves every artifact byte-identical (the timestamps mean
"last content change"), so `git status` shows only real edits.

## Schema

- `model_pricing.json`: see the upstream feed schema (README of
  LaoYueHanNi/model-price-table). All amounts RMB per million tokens.
- `provider_pricing.json`: see `provider_pricing.schema.json`. Core rules:
  - `providers[].provider` matches the provider route key **as recorded in the
    ledger** (`deepseek-official`, `opencode-go`, `commandcode`, `zai`,
    `staryears`, `modlens-commandcode`, …).
  - `providers[].billing` is the **channel's** billing nature and applies to
    every entry; an entry-level `billing` overrides it for a mixed channel.
    `metered` = real spend, `subscription` = plan value at the resolved rates
    (never actual spend).
  - `entries[].model` is the **exact model string as recorded** under that
    provider — which may carry a provider prefix (e.g.
    `deepseek/deepseek-v4-flash`) that the base table alone cannot match.
  - exactly one of `inheritBase: <modelId>` (follow the base model's full price
    history) or `segments[]` (the channel's own timeline, first segment from 0,
    last open-ended, flat rates only — no peak windows or context tiers).
  - `placeholder: true` marks a relay entry whose inherited official price is
    standing in until real `segments` are filled in.

## Pointing dsh-tokbook at this mirror

dsh-tokbook already resolves `(provider, model)` provider-first, and this repo's
provider layer is its default `pricingProviderUrl`. To use a fork or a
self-hosted raw URL, point both layers explicitly:

```yml
plugins:
  tokbook:
    pricingUrl: https://raw.githubusercontent.com/<you>/dsh-model-pricing/master/model_pricing.json
    pricingProviderUrl: https://raw.githubusercontent.com/<you>/dsh-model-pricing/master/provider_pricing.json
    # pricingRegion: domestic   # or a self-hosted gitee raw URL
```

## Status

- [x] Repo + two-layer structure, schema, generator, provenance
- [x] Base table extracted verbatim from the current synced mirror (185 models)
- [x] Provider layer seeded with the ledger's real `(provider, model)` combos:
      official/direct channels follow official history (`inheritBase`),
      subscription channels value at official history (channel `billing:
      subscription` + `inheritBase`), relay channels placeholder at official
      history (`placeholder: true`), unknown strings get no entry (reported as
      unpriced by the consumer)
- [x] Time dimension: provider entries follow the base table's `timeRules`
      history or carry an explicit `segments` timeline, so a vendor price
      change re-prices history without re-editing every channel
- [x] dsh-tokbook consumer resolves `(provider, model)` provider-first, follows
      `inheritBase`/`segments` timelines per record timestamp, AND keeps
      `metered` (actual spend) apart from `subscription` (plan value) when
      summing — the cost UI shows them as two separate figures
