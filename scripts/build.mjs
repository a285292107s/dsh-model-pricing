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
      const hasInherit = typeof entry.inheritBase === 'string' && entry.inheritBase !== ''
      const hasSegments = Array.isArray(entry.segments) && entry.segments.length > 0
      if (hasInherit && hasSegments) problems.push(`${id}: inheritBase and segments are mutually exclusive`)
      if (!hasInherit && !hasSegments) problems.push(`${id}: needs inheritBase (follow a base model) or segments (explicit timeline)`)
      if (hasSegments) {
        let lastTo = 0
        entry.segments.forEach((seg, index) => {
          const s = seg
          if (typeof s.rate !== 'object' || s.rate === null) {
            problems.push(`${id} segments[${index}]: rate required`)
            return
          }
          for (const key of ['inputPerMillion', 'outputPerMillion']) {
            if (typeof s.rate[key] !== 'number' || !Number.isFinite(s.rate[key]) || s.rate[key] < 0) {
              problems.push(`${id} segments[${index}].rate.${key}: must be a non-negative number`)
            }
          }
          if (s.from !== undefined && (typeof s.from !== 'number' || !Number.isFinite(s.from) || s.from < 0)) {
            problems.push(`${id} segments[${index}]: from must be a non-negative number`)
          }
          if (s.to !== undefined && (typeof s.to !== 'number' || !Number.isFinite(s.to))) {
            problems.push(`${id} segments[${index}]: to must be a number`)
          }
          if (s.from !== undefined && s.from < lastTo) problems.push(`${id} segments[${index}]: from (${s.from}) < previous to (${lastTo}) — segments must be ordered`)
          lastTo = s.to ?? lastTo
        })
      }
    }
  }
  return problems
}

// Flatten the base table model ids (modelId + aliases) for ref/inheritBase
// existence checks and rate lookup by the current snapshot (used only to
// derive the "current effective" preview; consumers follow the timeline live).
function baseLookup(base) {
  const byId = new Map()
  const aliasOf = new Map()
  for (const model of base.models) {
    byId.set(model.modelId, model)
    for (const alias of model.aliases ?? []) {
      if (alias !== '' && !aliasOf.has(alias)) aliasOf.set(alias, model)
    }
  }
  return { byId, aliasOf, resolve: (name) => byId.get(name) ?? aliasOf.get(name) }
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

  // 2) Provider layer compiled from the source facts. Each entry carries
  //    either inheritBase (follow a base model's FULL price history — official
  //    channels and subscription channels valued at official prices, so a
  //    vendor price change needs no edit here) or an explicit segments
  //    timeline (relay real prices, hand-priced unknown models). `billing`
  //    keeps metered spend apart from subscription value. The base table is
  //    consulted only to validate that an inheritBase target exists and to
  //    emit a human-readable "current effective rate" preview; consumers must
  //    resolve the timeline live from model_pricing.json + provider_pricing.json.
  const lookup = baseLookup(base)
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
        if (typeof e.inheritBase === 'string' && e.inheritBase !== '') {
          const target = lookup.resolve(e.inheritBase)
          if (target === undefined) {
            throw new Error(`${p.provider}/${e.model}: inheritBase "${e.inheritBase}" not found in the base table`)
          }
          out.inheritBase = e.inheritBase
          if (e.placeholder === true) out.placeholder = true
        } else if (Array.isArray(e.segments) && e.segments.length > 0) {
          out.segments = e.segments.map((s) => {
            const seg = { rate: s.rate }
            if (s.from !== undefined) seg.from = s.from
            if (s.to !== undefined) seg.to = s.to
            if (s.note !== undefined && s.note !== '') seg.note = s.note
            return seg
          })
        } else {
          throw new Error(`${p.provider}/${e.model}: needs inheritBase or segments`)
        }
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
