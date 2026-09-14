// Live end-to-end probe: the REAL plugin module, the REAL credential refs from
// ~/.dsh/.credentials.yaml, and the REAL network through the same shell seam the
// host provides. Prints which key each call actually used, so rotation and
// failover can be watched directly.
//
//   node tests/live-pool-check.cjs [query ...]
//
// This spends real Tavily quota — a few credits per query.
'use strict'

const { exec } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const PLUGIN = join(__dirname, '..', 'src', 'tavily-web.ts')
const CREDENTIALS = process.env.DSH_CREDENTIALS || join(homedir(), '.dsh', '.credentials.yaml')
const QUERIES = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['DeepSeek V4 发布', 'Tavily API pricing', 'Asia Shanghai weather today']

// Minimal reader for the credentials file's flat `refs:` mapping. Deliberately
// not a YAML parser: the file's ref section is line-oriented and this avoids a
// dependency the plugin itself does not carry.
function readCredentialRefs(file) {
  const refs = {}
  let inRefs = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^[A-Za-z0-9_.-]+:/.test(line)) {
      inRefs = /^refs:\s*$/.test(line)
      continue
    }
    if (!inRefs) continue
    const m = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) refs[m[1]] = value
  }
  return refs
}

async function main() {
  const mod = await import(pathToFileURL(PLUGIN).href)
  const refs = readCredentialRefs(CREDENTIALS)
  const tavilyRefs = Object.keys(refs).filter((k) => /^TAVILY_API_KEY(_\d+)?$/.test(k)).sort()
  if (tavilyRefs.length === 0) {
    console.error(`no TAVILY_API_KEY* reference found in ${CREDENTIALS}`)
    process.exit(1)
  }
  console.log(`credentials: ${tavilyRefs.length} Tavily ref(s) -> ${tavilyRefs.join(', ')}\n`)

  const used = []
  const realShell = async (request) =>
    await new Promise((resolve) => {
      used.push(request.env && request.env.TAVILY_API_KEY)
      exec(
        request.command,
        {
          env: { ...process.env, ...(request.env || {}) },
          timeout: request.timeoutMs || 30000,
          maxBuffer: request.stdoutMaxBytes || 4 * 1024 * 1024,
          shell: '/bin/bash',
        },
        (err, stdout, stderr) => {
          const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
          resolve({
            exitCode: code,
            aborted: false,
            timedOut: false,
            stdout: { text: String(stdout), truncated: false },
            stderr: { text: String(stderr) },
          })
        },
      )
    })

  const tools = []
  mod.apply({
    tools: { register: (t) => tools.push(t) },
    web: { registerFetchProvider: () => {} },
    credentials: {
      resolve: async (name) => {
        const value = refs[name]
        if (value === undefined || String(value).length === 0) return undefined
        return { value: String(value), source: CREDENTIALS }
      },
    },
    shell: { resolve: (r) => r, run: realShell },
  }, mod.Config(undefined))

  const search = tools.find((t) => t.name === 'tavily_search')
  const short = (k) => (k === undefined ? '?' : '…' + k.slice(-4))

  for (const query of QUERIES) {
    const before = used.length
    try {
      const value = await search.execute({ query, max_results: 2 }, { signal: undefined })
      console.log(`query: ${query}`)
      console.log(`  OK via ${short(used[before])}  keys tried this call: [${used.slice(before).map(short).join(' -> ')}]`)
      console.log(`  ${value.sources.length} source(s): ${value.sources.map((s) => s.title || s.url).slice(0, 2).join(' | ')}\n`)
    } catch (e) {
      console.log(`query: ${query}\n  FAILED: ${e.message}\n`)
    }
  }

  console.log(`key usage across all calls: [${used.map(short).join(', ')}]`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
