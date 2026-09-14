import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'tavily-web'
export const inject = ['tools', 'web', 'shell', 'credentials']

/**
 * The default pool membership: the `TAVILY_API_KEY` family.
 *
 * Declared once and used both by the schema and by the code, so a loader that
 * validates the exported Config and a loader that passes it through untouched
 * cannot disagree about which references the pool covers.
 */
const DEFAULT_KEY_REFS = [
  'TAVILY_API_KEY',
  'TAVILY_API_KEY_2',
  'TAVILY_API_KEY_3',
  'TAVILY_API_KEY_4',
  'TAVILY_API_KEY_5',
  'TAVILY_API_KEY_6',
  'TAVILY_API_KEY_7',
  'TAVILY_API_KEY_8',
]

/**
 * Key-pool configuration for the Tavily tools.
 *
 * `keyRefs` names the CredentialRefs the pool rotates through, in order. The
 * default is that family rather than a single name because the credentials seam
 * deliberately has no way to enumerate its references — a configuration surface
 * learns which references exist from a schema, not from the service — so the
 * pool's membership has to be declared somewhere. Declaring the whole family
 * costs nothing: resolving a name nobody configured returns undefined, which the
 * pool skips, so dropping `TAVILY_API_KEY_2` into ~/.dsh/.credentials.yaml is
 * enough to join the rotation, with no composition edit.
 */
export const Config = z.object({
  /** Credential reference names in the rotation pool, highest priority first. */
  keyRefs: z.array(z.string()).default(DEFAULT_KEY_REFS),
  /** Literal keys appended after every keyRefs entry; the seam is the better home for a secret. */
  apiKeys: z.array(z.string()).default([]),
  /** Seconds a key that answered 401/403/429/432 stays out of rotation. */
  cooldownSeconds: z.number().default(900),
})

export function apply(ctx: any, config?: any) {
  // Single-quote a string for POSIX shells, escaping embedded quotes.
  const esc = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'"
  const abortedError = () => { const e = new Error('operation aborted'); e.name = 'AbortError'; return e }

  // One foreground curl run through the shell seam.
  const runCurl = async (command: string, extra: any, signal?: AbortSignal) => {
    const request = Object.assign({ command, signal, timeoutMs: 30000, stdoutMaxBytes: 4 * 1024 * 1024 }, extra || {})
    const result = await ctx.shell.run(ctx.shell.resolve(request))
    if (result.aborted === true) throw abortedError()
    if (result.timedOut === true) throw new Error('request timed out')
    return result
  }

  // Very small HTML->text extractor (no DOM library; regex is enough for a learning tool).
  const htmlToText = (html: string) => {
    let s = String(html)
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    s = s.replace(/<[^>]*>/g, ' ')
    s = s.replace(/&nbsp;/gi, ' ')
    s = s.replace(/&amp;/gi, '&')
    s = s.replace(/&lt;/gi, '<')
    s = s.replace(/&gt;/gi, '>')
    s = s.replace(/&quot;/gi, '"')
    s = s.replace(/&#39;/g, "'")
    s = s.replace(/&#x27;/gi, "'")
    s = s.replace(/[ \t]{2,}/g, ' ')
    s = s.replace(/ ?\n ?/g, '\n')
    s = s.replace(/\n{2,}/g, '\n')
    return s.trim()
  }

  // Fetch one URL: curl -w appends a status marker after the body.
  const fetchPage = async (url: string, signal?: AbortSignal) => {
    if (typeof url !== 'string' || /^https?:\/\//i.test(url) !== true) {
      throw new Error('url must be an absolute http(s) URL')
    }
    if (signal != null && signal.aborted === true) throw abortedError()
    const marker = '\n__DSH_FETCH_STATUS__:'
    const command =
      'curl -sSL --max-time 25 -A ' + esc('Mozilla/5.0 (compatible; DSH-web-fetch/1.0)') +
      ' -w ' + esc(marker + '%{http_code}') + ' ' + esc(url)
    const result = await runCurl(command, {}, signal)
    const raw = result.stdout ? result.stdout.text : ''
    const idx = raw.lastIndexOf(marker)
    if (idx < 0) throw new Error('curl returned no status marker (output truncated?)')
    const statusCode = Number(raw.slice(idx + marker.length).trim())
    if (Number.isFinite(statusCode) !== true || statusCode === 0) {
      const detail = result.stderr && result.stderr.text ? String(result.stderr.text).slice(-400) : ''
      throw new Error('curl could not connect: ' + detail)
    }
    const bodyRaw = raw.slice(0, idx)
    const isHtml = /<html[\s>]/i.test(bodyRaw) || /<!doctype html/i.test(bodyRaw)
    const text = isHtml ? htmlToText(bodyRaw) : bodyRaw
    const limit = 20000
    return {
      url,
      statusCode,
      body: { kind: isHtml ? 'html' : 'text', content: text.slice(0, limit) },
      truncated: result.stdout.truncated === true || text.length > limit,
    }
  }

  // Pull a human-readable reason out of a Tavily error body (detail.error / detail / message).
  const tavilyErrorDetail = (data: any, statusCode: number) => {
    const detail = data != null ? data.detail : undefined
    if (typeof detail === 'string' && detail.length > 0) return detail
    if (detail != null) {
      if (typeof detail.error === 'string' && detail.error.length > 0) return detail.error
      if (typeof detail.message === 'string' && detail.message.length > 0) return detail.message
    }
    if (data != null && typeof data.error === 'string' && data.error.length > 0) return data.error
    if (data != null && typeof data.message === 'string' && data.message.length > 0) return data.message
    if (statusCode === 401) return 'invalid or revoked API key (check TAVILY_API_KEY)'
    if (statusCode === 429) return 'rate limit exceeded; retry later'
    if (statusCode === 432) return "this request exceeds your plan's set usage limit (see https://api.tavily.com/usage)"
    return 'unexpected response: ' + JSON.stringify(data).slice(0, 200)
  }

  // ── key pool ──────────────────────────────────────────────────────────────
  //
  // Tavily meters quota per key, so one exhausted account must not take the tool
  // down with it. Entries are addressed by reference name and never by value: the
  // credentials seam resolves per operation (a credential corrected between two
  // calls must reach the next one without a restart), so the pool stores no key —
  // only a fingerprint, which tells a rotated secret apart from a benched one.

  const conf = config != null && typeof config === 'object' ? config : {}

  // Non-reversible, stable per secret: identifies *which* value a reference points
  // at without retaining key material in memory.
  const fingerprint = (key: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
    }
    return h.toString(16)
  }

  const maskKey = (key: string) => (key.length <= 8 ? '****' : key.slice(0, 10) + '…' + key.slice(-4))

  const pool: any[] = []
  {
    const refs = Array.isArray(conf.keyRefs) ? conf.keyRefs : DEFAULT_KEY_REFS
    const seen = new Set<string>()
    for (const raw of refs) {
      const ref = raw == null ? '' : String(raw).trim()
      if (ref.length === 0 || seen.has(ref)) continue
      seen.add(ref)
      pool.push({ id: ref, ref })
    }
    const literals = Array.isArray(conf.apiKeys) ? conf.apiKeys : []
    for (let i = 0; i < literals.length; i++) {
      const value = literals[i] == null ? '' : String(literals[i]).trim()
      if (value.length === 0) continue
      pool.push({ id: 'config.apiKeys[' + String(i) + '] ' + maskKey(value), literal: value })
    }
  }

  const cooldownSeconds = Number(conf.cooldownSeconds)
  const cooldownMs = Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0 ? cooldownSeconds * 1000 : 900000

  // Health per entry id. A 401 is treated as standing (the key itself is refused)
  // while 403/429/432 expire with the cooldown, so a reset quota rejoins on its own.
  const bench = new Map<string, { until: number; permanent: boolean; fingerprint: string }>()
  let cursor = 0

  const resolveKey = async (entry: any): Promise<string | undefined> => {
    if (entry.literal !== undefined) return entry.literal
    try {
      const hit = await ctx.credentials.resolve(entry.ref)
      const value = hit != null && hit.value != null ? String(hit.value) : ''
      return value.length > 0 ? value : undefined
    } catch (e) {
      return undefined
    }
  }

  const holding = (entry: any, fp: string) => {
    const state = bench.get(entry.id)
    if (state === undefined) return false
    // The reference now resolves to a different secret: whatever was wrong with the
    // old one cannot apply to this one, so the entry is healthy again immediately.
    if (state.fingerprint !== fp) {
      bench.delete(entry.id)
      return false
    }
    return state.permanent === true || Date.now() < state.until
  }

  const benchEntry = (entry: any, fp: string, code: number) => {
    bench.set(entry.id, {
      until: Date.now() + cooldownMs,
      permanent: code === 401,
      fingerprint: fp,
    })
  }

  // Entries in rotation order, starting at the cursor so successive calls spread
  // across healthy keys instead of pinning the first one.
  const attemptOrder = () => {
    const out: any[] = []
    for (let i = 0; i < pool.length; i++) out.push(pool[(cursor + i) % pool.length])
    return out
  }

  // Statuses another key can plausibly answer: the failure is about this key's
  // account, not about the request. Anything else (400, 5xx, transport) is fatal
  // at once — burning the rest of the pool on it would only hide the real problem.
  const RETRYABLE_STATUS = new Set([401, 403, 429, 432])

  // One Tavily call with one key.
  const searchWithKey = async (key: string, query: string, limit: number, signal?: AbortSignal) => {
    const payload = JSON.stringify({ query: String(query), max_results: limit, search_depth: 'basic' })
    // curl still exits 0 when the API returns an error body, so the HTTP status is
    // captured with -w and read back below. Without it a 401/429/432 body parses as
    // valid JSON that simply has no `results`, and the tool silently reports
    // "0 sources" instead of failing.
    const marker = '\n__DSH_TAVILY_STATUS__:'
    const command =
      'curl -sS --max-time 25 -X POST https://api.tavily.com/search' +
      ' -H "Content-Type: application/json"' +
      ' -H "Authorization: Bearer $TAVILY_API_KEY"' +
      ' -w ' + esc(marker + '%{http_code}') +
      ' --data-binary ' + esc(payload)
    const result = await runCurl(command, { env: { TAVILY_API_KEY: key } }, signal)
    if (result.exitCode !== 0) {
      const detail = result.stderr && result.stderr.text ? String(result.stderr.text).slice(-400) : ''
      throw new Error('tavily search failed (exit ' + String(result.exitCode) + '): ' + detail)
    }
    const raw = result.stdout && result.stdout.text ? String(result.stdout.text) : ''
    const idx = raw.lastIndexOf(marker)
    if (idx < 0) throw new Error('tavily search: curl returned no status marker (output truncated?)')
    const statusCode = Number(raw.slice(idx + marker.length).trim())
    const bodyText = raw.slice(0, idx)
    if (Number.isFinite(statusCode) !== true || statusCode === 0) {
      const detail = result.stderr && result.stderr.text ? String(result.stderr.text).slice(-400) : ''
      throw new Error('tavily search could not connect: ' + detail)
    }
    let data
    try {
      data = JSON.parse(bodyText)
    } catch (e) {
      throw new Error('tavily returned non-JSON (HTTP ' + String(statusCode) + '): ' + bodyText.slice(-200))
    }
    if (statusCode >= 400) {
      return {
        ok: false,
        statusCode,
        reason: tavilyErrorDetail(data, statusCode),
        retryable: RETRYABLE_STATUS.has(statusCode),
      }
    }
    const all = Array.isArray(data.results) ? data.results : []
    const sources = all.slice(0, limit).map((r: any) => {
      const out: any = { url: String(r.url) }
      if (r.title != null && String(r.title).length > 0) out.title = String(r.title)
      if (r.content != null && String(r.content).length > 0) out.snippet = String(r.content).slice(0, 600)
      if (r.published_date != null && String(r.published_date).length > 0) out.publishedAt = String(r.published_date)
      return out
    })
    const out: any = { sources, truncated: all.length > limit }
    if (data.answer != null && String(data.answer).length > 0) out.content = String(data.answer)
    return { ok: true, value: out }
  }

  // Rotate: try healthy keys from the cursor, then retry the benched ones once as a
  // last resort. That second pass is what lets a reset quota rejoin without a
  // restart, and it keeps the failure honest — the caller sees the API's own answer
  // rather than "every key is benched".
  const tavilySearch = async (query: string, maxResults: any, signal?: AbortSignal) => {
    if (signal != null && signal.aborted === true) throw abortedError()
    if (pool.length === 0) {
      throw new Error('tavily search: the key pool is empty — declare config.keyRefs (e.g. [TAVILY_API_KEY, TAVILY_API_KEY_2]) or config.apiKeys on the tavily-web row.')
    }
    const limit = Math.min(Math.max(Number(maxResults) || 5, 1), 20)
    const attempts: any[] = []
    const deferred: any[] = []

    const attempt = async (entry: any, key: string, lastResort: boolean) => {
      if (signal != null && signal.aborted === true) throw abortedError()
      const outcome: any = await searchWithKey(key, query, limit, signal)
      if (outcome.ok === true) {
        bench.delete(entry.id)
        cursor = (pool.indexOf(entry) + 1) % pool.length
        return { value: outcome.value }
      }
      if (outcome.retryable !== true) {
        throw new Error('tavily search failed (HTTP ' + String(outcome.statusCode) + '): ' + outcome.reason)
      }
      benchEntry(entry, fingerprint(key), outcome.statusCode)
      attempts.push({
        id: entry.id,
        outcome: 'HTTP ' + String(outcome.statusCode),
        reason: outcome.reason,
        lastResort,
        retryableAt: outcome.statusCode === 401 ? undefined : new Date(Date.now() + cooldownMs),
      })
      return undefined
    }

    for (const entry of attemptOrder()) {
      const key = await resolveKey(entry)
      if (key === undefined) {
        attempts.push({ id: entry.id, outcome: 'not configured' })
        continue
      }
      if (holding(entry, fingerprint(key))) {
        deferred.push({ entry, key })
        continue
      }
      const done = await attempt(entry, key, false)
      if (done !== undefined) return done.value
    }

    for (const item of deferred) {
      const done = await attempt(item.entry, item.key, true)
      if (done !== undefined) return done.value
    }

    if (attempts.every((a) => a.outcome === 'not configured')) {
      throw new Error(
        'tavily search: no key is configured for the pool (' + pool.map((e: any) => e.id).join(', ') + ').' +
        ' Add e.g. "TAVILY_API_KEY: <tvly-...>" to ~/.dsh/.credentials.yaml, or declare config.keyRefs / config.apiKeys on the tavily-web row.',
      )
    }
    const lines = attempts.map((a) => {
      const retry = a.retryableAt !== undefined ? ' (retry after ' + a.retryableAt.toISOString() + ')' : ''
      const tag = a.lastResort === true ? ' [last resort]' : ''
      return '  - ' + a.id + ': ' + a.outcome + (a.reason !== undefined ? ' — ' + a.reason : '') + retry + tag
    })
    throw new Error('tavily search: all ' + String(pool.length) + ' key(s) in the pool failed\n' + lines.join('\n'))
  }

  // L2: fetch provider into the HOST web registry (host-plane singleton, registered once;
  // the deployment ships no fetch provider, so this is the single usable one the seam selects).
  // Search is deliberately NOT registered as a provider: a second usable search provider
  // next to the shipped DeepSeek one would make web.search() ambiguous.
  ctx.web.registerFetchProvider({
    id: 'dsh-curl-fetch',
    available: () => true,
    fetch: (request: any, signal?: AbortSignal) => fetchPage(request.url, signal),
  })

  // L1: model-visible tools, registered into the host tools registry (every session sees them).
  ctx.tools.register(defineTool({
    name: 'tavily_search',
    description: 'Search the web through the Tavily API. Returns ranked sources with url/title/snippet and an optional short answer. Keys are rotated across a pool, so one exhausted account does not disable the tool.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      max_results: { type: 'integer', description: 'Number of sources to return, 1-20 (default 5).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any, exec: any) {
      return tavilySearch(String(args.query), args.max_results, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'Fetch one web page through the curl fetch provider and return its HTTP status plus extracted text.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to fetch.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: any, exec: any) {
      return ctx.web.fetch({ url: String(args.url) }, exec.signal)
    },
  }))

  const configured = pool.length
  console.log(
    '[tavily-web] registered tavily_search / web_fetch + curl fetch provider' +
    ' (key pool: ' + String(configured) + ' ref(s), cooldown ' + String(Math.round(cooldownMs / 1000)) + 's)',
  )
}
