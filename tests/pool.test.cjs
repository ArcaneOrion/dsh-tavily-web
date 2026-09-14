// Offline behaviour suite for the Tavily key pool.
//
// Loads the REAL plugin module and drives the registered tavily_search through a
// scripted shell, so failover, benching and rotation are observable without
// touching the network or spending anyone's quota.
//
//   node tests/pool.test.cjs
//
// With VERIFY_TAVILY_KEY set, case A additionally runs against the live API.
'use strict'

const { exec } = require('node:child_process')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const PLUGIN = join(__dirname, '..', 'src', 'tavily-web.ts')
const PLUGIN_LABEL = 'tavily search' // console prefix to silence in output

// ── mocks ───────────────────────────────────────────────────────────────────

function makeCtx(shellRun, creds) {
  const tools = []
  return {
    ctx: {
      tools: { register: (t) => tools.push(t) },
      web: { registerFetchProvider: () => {} },
      credentials: {
        resolve: async (name) => {
          const value = creds[name]
          // The seam reports an unconfigured reference as undefined, and treats an
          // empty stored value as absent everywhere.
          if (value === undefined || String(value).length === 0) return undefined
          return { value: String(value), source: 'test' }
        },
      },
      shell: { resolve: (r) => r, run: shellRun },
    },
    tools,
  }
}

// Real shell: mirrors the host seam by actually running the command.
const realShell = async (request) =>
  await new Promise((resolve) => {
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

// Scripted shell: answers per key, and records the order keys were used in.
function scriptedShell(responder) {
  const calls = []
  const run = async (request) => {
    const key = (request.env || {}).TAVILY_API_KEY
    calls.push(key)
    const answer = responder(key)
    return {
      exitCode: 0,
      aborted: false,
      timedOut: false,
      stdout: { text: JSON.stringify(answer.body) + '\n__DSH_TAVILY_STATUS__:' + answer.status, truncated: false },
      stderr: { text: '' },
    }
  }
  run.calls = calls
  return run
}

async function mount(mod, shellRun, creds, config) {
  const { ctx, tools } = makeCtx(shellRun, creds)
  // Config goes through the exported schema first, exactly as the loader does at
  // mount time: this is what makes the declared pool default — not a hand-written
  // array in the test — the thing under test.
  const validated = typeof mod.Config === 'function' ? mod.Config(config) : config
  mod.apply(ctx, validated)
  const tool = tools.find((t) => t.name === 'tavily_search')
  if (!tool) throw new Error('tavily_search was not registered')
  return tool
}

const callTool = async (tool, args) => {
  try {
    return { ok: true, value: await tool.execute(args, { signal: undefined }) }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

const OK_BODY = (tag) => ({ results: [{ url: 'https://example.com/' + tag, title: tag, content: 'snippet ' + tag }] })
const QUOTA = { status: 432, body: { detail: { error: 'This request exceeds your plan set usage limit.' } } }
const AUTH = { status: 401, body: { detail: { error: 'Invalid API key' } } }

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`)
}

// ── suite ───────────────────────────────────────────────────────────────────

async function main() {
  const mod = await import(pathToFileURL(PLUGIN).href)

  // A: live network, real key (opt-in).
  if (process.env.VERIFY_TAVILY_KEY) {
    const tool = await mount(mod, realShell, { TAVILY_API_KEY: process.env.VERIFY_TAVILY_KEY })
    const r = await callTool(tool, { query: 'DeepSeek', max_results: 3 })
    const pass = (r.ok === false && /HTTP \d{3}/.test(r.error)) || r.ok === true
    check('A live call reports the real HTTP outcome (never a silent empty result)', pass,
      r.ok ? `ok, ${r.value.sources.length} source(s)` : r.error)
  } else {
    console.log('SKIP  A live call (set VERIFY_TAVILY_KEY to enable)\n')
  }

  // B: success path unchanged.
  {
    const shell = scriptedShell(() => ({ status: 200, body: {
      results: [
        { url: 'https://example.com/a', title: 'Alpha', content: 'first', published_date: '2026-09-01' },
        { url: 'https://example.com/b', title: 'Beta', content: 'second' },
      ], answer: 'short answer' } }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'k1' })
    const r = await callTool(tool, { query: 'x', max_results: 5 })
    const pass = r.ok && r.value.sources.length === 2 && r.value.sources[0].publishedAt === '2026-09-01' &&
      r.value.content === 'short answer' && r.value.truncated === false
    check('B success path parses sources/answer and strips the status marker', pass, JSON.stringify(r))
  }

  // C: genuine zero-result 200 stays a valid empty answer.
  {
    const shell = scriptedShell(() => ({ status: 200, body: { results: [] } }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'k1' })
    const r = await callTool(tool, { query: 'x' })
    check('C a real zero-result 200 is not turned into an error', r.ok && r.value.sources.length === 0, JSON.stringify(r))
  }

  // D: failover on quota exhaustion.
  {
    const shell = scriptedShell((key) => (key === 'dry' ? QUOTA : { status: 200, body: OK_BODY('second') }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'dry', TAVILY_API_KEY_2: 'wet' })
    const r = await callTool(tool, { query: 'x' })
    const pass = r.ok && r.value.sources[0].title === 'second' && shell.calls.join(',') === 'dry,wet'
    check('D quota-dead key fails over to the next key in the pool', pass, `calls=[${shell.calls}] ${JSON.stringify(r)}`)
  }

  // E: a failed key is benched, not retried on the next call.
  {
    const shell = scriptedShell((key) => (key === 'dry' ? QUOTA : { status: 200, body: OK_BODY('wet') }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'dry', TAVILY_API_KEY_2: 'wet' })
    await callTool(tool, { query: 'x' })
    const afterFirst = shell.calls.length
    await callTool(tool, { query: 'y' })
    const secondCallKeys = shell.calls.slice(afterFirst)
    check('E benched key is skipped on later calls (no wasted request)', secondCallKeys.join(',') === 'wet',
      `first call=[${shell.calls.slice(0, afterFirst)}] second call=[${secondCallKeys}]`)
  }

  // F: round-robin spreads successive calls across healthy keys.
  {
    const shell = scriptedShell((key) => ({ status: 200, body: OK_BODY(key) }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'k1', TAVILY_API_KEY_2: 'k2' })
    await callTool(tool, { query: 'a' })
    await callTool(tool, { query: 'b' })
    await callTool(tool, { query: 'c' })
    check('F rotation advances across calls (k1,k2,k1)', shell.calls.join(',') === 'k1,k2,k1', `calls=[${shell.calls}]`)
  }

  // G: 401 surfaces the API reason.
  {
    const shell = scriptedShell(() => AUTH)
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'bad' })
    const r = await callTool(tool, { query: 'x' })
    const pass = r.ok === false && /HTTP 401/.test(r.error) && /Invalid API key/.test(r.error)
    check('G auth failure surfaces the API reason', pass, r.ok ? JSON.stringify(r) : r.error)
  }

  // H: every key down reports each one.
  {
    const shell = scriptedShell(() => QUOTA)
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'a', TAVILY_API_KEY_2: 'b' })
    const r = await callTool(tool, { query: 'x' })
    const pass = r.ok === false && /all 8 key\(s\) in the pool failed/.test(r.error) &&
      r.error.includes('- TAVILY_API_KEY: HTTP 432') && r.error.includes('- TAVILY_API_KEY_2: HTTP 432') &&
      /usage limit/.test(r.error)
    check('H total failure lists every key and its reason', pass, r.ok ? JSON.stringify(r) : r.error)
  }

  // I: unconfigured references are skipped silently.
  {
    const shell = scriptedShell(() => ({ status: 200, body: OK_BODY('only') }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY_2: 'only' })
    const r = await callTool(tool, { query: 'x' })
    check('I unconfigured pool members cost nothing and stay invisible', r.ok && shell.calls.join(',') === 'only',
      `calls=[${shell.calls}] ${JSON.stringify(r)}`)
  }

  // J: nothing configured gives the actionable message.
  {
    const shell = scriptedShell(() => ({ status: 200, body: OK_BODY('x') }))
    const tool = await mount(mod, shell, {})
    const r = await callTool(tool, { query: 'x' })
    const pass = r.ok === false && /no key is configured/.test(r.error) && /credentials\.yaml/.test(r.error)
    check('J empty configuration explains how to add a key', pass, r.ok ? JSON.stringify(r) : r.error)
  }

  // K: a benched key recovers once the credential is rotated.
  {
    const shell = scriptedShell((key) => (key === 'old-dead' ? QUOTA : { status: 200, body: OK_BODY('fresh') }))
    const creds = { TAVILY_API_KEY: 'old-dead' }
    const tool = await mount(mod, shell, creds, { keyRefs: ['TAVILY_API_KEY'] })
    await callTool(tool, { query: 'x' })
    creds.TAVILY_API_KEY = 'new-live'
    const r = await callTool(tool, { query: 'y' })
    check('K replacing the secret behind a benched reference revives it at once',
      r.ok && r.value.sources[0].title === 'fresh', JSON.stringify(r))
  }

  // L: last-resort pass picks up a quota that reset.
  {
    let healthy = false
    const shell = scriptedShell(() => (healthy ? { status: 200, body: OK_BODY('recovered') } : QUOTA))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'same-key' }, { keyRefs: ['TAVILY_API_KEY'], cooldownSeconds: 3600 })
    const first = await callTool(tool, { query: 'x' })
    healthy = true
    const second = await callTool(tool, { query: 'y' })
    check('L a key whose quota reset rejoins without a restart',
      first.ok === false && second.ok === true && second.value.sources[0].title === 'recovered',
      `first=${first.ok ? 'ok' : 'failed'} second=${JSON.stringify(second)}`)
  }

  // M: a non-key failure is fatal and must not burn other keys.
  {
    const shell = scriptedShell(() => ({ status: 400, body: { detail: { error: 'Bad request' } } }))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'k1', TAVILY_API_KEY_2: 'k2' })
    const r = await callTool(tool, { query: 'x' })
    check('M HTTP 400 fails fast without trying the other keys',
      r.ok === false && /HTTP 400/.test(r.error) && shell.calls.length === 1, `calls=${shell.calls.length} ${r.error}`)
  }

  // N: literal config.apiKeys join the pool.
  {
    const shell = scriptedShell((key) => (key === 'inline-secret-1' ? { status: 200, body: OK_BODY('inline') } : QUOTA))
    const tool = await mount(mod, shell, { TAVILY_API_KEY: 'dry' }, { apiKeys: ['inline-secret-1'] })
    const r = await callTool(tool, { query: 'x' })
    check('N config.apiKeys entries are usable pool members',
      r.ok && r.value.sources[0].title === 'inline', JSON.stringify(r))
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
