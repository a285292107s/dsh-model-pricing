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

### Billing classes — keep them apart when summing

Every provider entry carries a `billing` class plus its resolved `rate`
(`rateSource` says where the rate came from):

- **`metered`** — a REAL per-token spend: an official/relay API that actually
  charges. Summing `metered` rows gives actual out-of-pocket spend.
- **`subscription`** — the model is included in a plan; calls are not charged
  per token. Its `rate` is the **metered-equivalent VALUE the subscription
  creates** (what those calls would have cost at the official/metered rate),
  **not actual spend**. A consumer MUST NOT mix `subscription` rows into an
  actual-spend total; report them as subscription value instead.

Three source conventions the build resolves automatically:

1. **Official/direct channels** (`deepseek-official`, `zai`, …) — `metered`,
   rate inherited from the base table (`rateSource: inherited`).
2. **Relay/reseller channels** (`staryears`, …) — `metered`, rate currently a
   **placeholder copied from the official price** (`rateSource: inherited`);
   the user is expected to replace it with the relay's real rate (`rate` +
   `rateSource: explicit`).
3. **Unknown model strings** (e.g. `dots3-note-prev`) — default **¥0**
   (`rateSource: zero`), waiting for the user to fill a real price.

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
- [x] Provider layer seeded with the ledger's real `(provider, model)` combos,
      each resolved to an effective rate + `billing` class per your rules:
      subscription channels value at official price; relays placeholder at
      official price pending your real relay rate; unknown strings default ¥0
- [ ] dsh-tokbook consumer resolves `(provider, model)` provider-first AND keeps
      `metered` (actual spend) apart from `subscription` (plan value) when
      summing — the cost UI will show them as two separate figures
