#!/usr/bin/env node
// Build the dsh-model-pricing artifacts from sources:
//
//   1. model_pricing.json        — model base table (RMB / per million tokens),
//                                  extracted VERBATIM from the currently synced
//                                  tokbook mirror (pricing.ccsa.json). Zero
//                                  invention: we copy the maintained upstream
//                                  table so the repo starts from real data and
//                                  stays usable by existing model-only consumers.
//   2. provider_pricing.json     — the per-provider override layer, compiled
//                                  from providers.source.json (the hand-edited
//                                  fact list: which channels bill metered vs.
//                                  subscription, and any channel-specific rate).
//
// Usage: node scripts/build.mjs [path-to-pricing.ccsa.json]
//   (defaults to $DSH_HOME/tokbook/pricing.ccsa.json or ~/.dsh/tokbook/…)
//
// The build never fetches the network; it reads the local mirror if present,
// else carries over a committed fallback (see ./fallback/). All edits to
// pricing facts happen in providers.source.json; the base table is refreshed
// by re-running against a newer local mirror.

import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MIRROR_CANDIDATES = [
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'tokbook', 'pricing.ccsa.json') : null,
  join(process.env.USERPROFILE ?? '', '.dsh', 'tokbook', 'pricing.ccsa.json'),
  join(process.env.HOME ?? '', '.dsh', 'tokbook', 'pricing.ccsa.json'),
].filter(Boolean)

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function nowUnix() { return Math.floor(Date.now() / 1000) }

async function loadBaseTable() {
  const given = process.argv[2]
  const candidates = given !== undefined ? [given] : DEFAULT_MIRROR_CANDIDATES
  for (const path of candidates) {
    if (!(await exists(path))) continue
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.models) && parsed.models.length > 0) {
      console.log(`base table: ${path} (${parsed.models.length} models)`)
      return parsed
    }
    console.warn(`ignoring empty/invalid mirror at ${path}`)
  }
  throw new Error('No usable base table found. Pass a path to pricing.ccsa.json or sync the tokbook mirror first.')
}

async function loadProviderSource() {
  const path = join(root, 'providers.source.json')
  return JSON.parse(await readFile(path, 'utf8'))
}

// Light validation of the source fact list: shape, required fields, enum.
function validateProviderSource(source) {
  const problems = []
  if (!Array.isArray(source.providers)) problems.push('providers must be an array')
  const seen = new Set()
  for (const provider of source.providers) {
    if (typeof provider.provider !== 'string' || provider.provider === '') {
      problems.push('every provider needs a non-empty "provider" key')
      continue
    }
    if (!Array.isArray(provider.entries)) {
      problems.push(`${provider.provider}: entries must be an array`)
      continue
    }
    for (const entry of provider.entries) {
      const id = `${provider.provider}/${entry.model ?? '(?)'}`
      if (seen.has(id)) problems.push(`duplicate entry ${id}`)
      seen.add(id)
      if (typeof entry.model !== 'string' || entry.model === '') problems.push(`${id}: model required`)
      if (entry.billing !== 'metered' && entry.billing !== 'subscription') {
        problems.push(`${id}: billing must be metered|subscription`)
      }
      if (entry.billing === 'metered' && entry.rate === undefined) {
        // Allowed: metered with no override inherits the base table rate.
      }
      if (entry.rate !== undefined) {
        const r = entry.rate
        for (const key of ['inputPerMillion', 'outputPerMillion']) {
          if (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || r[key] < 0) {
            problems.push(`${id}: rate.${key} must be a non-negative number`)
          }
        }
      }
    }
  }
  return problems
}

async function main() {
  const base = await loadBaseTable()
  const source = await loadProviderSource()

  const problems = validateProviderSource(source)
  if (problems.length > 0) {
    console.error('providers.source.json is invalid:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  // 1) Base table: verbatim copy (bump only updatedAt? No — preserve upstream
  //    version/updatedAt exactly; consumers compare those to decide re-fetch.)
  const baseOut = join(root, 'model_pricing.json')
  await writeFile(baseOut, JSON.stringify(base, null, 2) + '\n', 'utf8')

  // 2) Provider layer compiled from the source facts.
  const providerOut = {
    version: source.version,
    updatedAt: nowUnix(),
    currency: 'RMB',
    usdExchangeRate: base.usdExchangeRate ?? 7,
    providers: source.providers.map((p) => ({
      provider: p.provider,
      ...(p.label !== undefined ? { label: p.label } : {}),
      entries: p.entries.map((e) => {
        const out = { model: e.model, billing: e.billing }
        if (e.rate !== undefined) out.rate = e.rate
        if (e.note !== undefined && e.note !== '') out.note = e.note
        return out
      }),
    })),
  }
  const providerPath = join(root, 'provider_pricing.json')
  await writeFile(providerPath, JSON.stringify(providerOut, null, 2) + '\n', 'utf8')

  // 3) Emit a provenance note so the base table's origin stays auditable.
  const metaPath = join(root, 'BASE_SOURCE.json')
  await writeFile(metaPath, JSON.stringify({
    baseTableSource: 'local tokbook mirror (pricing.ccsa.json)',
    baseVersion: base.version,
    baseUpdatedAt: base.updatedAt,
    models: base.models.length,
    builtAt: nowUnix(),
  }, null, 2) + '\n', 'utf8')

  console.log(`wrote model_pricing.json (${base.models.length} models)`)
  console.log(`wrote provider_pricing.json (${providerOut.providers.length} providers)`)
  console.log(`wrote BASE_SOURCE.json (provenance)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
