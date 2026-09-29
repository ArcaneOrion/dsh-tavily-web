import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
const name = "tavily-web";
const inject = ["tools", "web", "shell", "credentials"];
const DEFAULT_KEY_REFS = [
  "TAVILY_API_KEY",
  "TAVILY_API_KEY_2",
  "TAVILY_API_KEY_3",
  "TAVILY_API_KEY_4",
  "TAVILY_API_KEY_5",
  "TAVILY_API_KEY_6",
  "TAVILY_API_KEY_7",
  "TAVILY_API_KEY_8"
];
const Config = z.object({
  /** Credential reference names in the rotation pool, highest priority first. */
  keyRefs: z.array(z.string()).default(DEFAULT_KEY_REFS),
  /** Literal keys appended after every keyRefs entry; the seam is the better home for a secret. */
  apiKeys: z.array(z.string()).default([]),
  /** Seconds a key that answered 401/403/429/432 stays out of rotation. */
  cooldownSeconds: z.number().default(900)
});
function apply(ctx, config) {
  const esc = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const abortedError = () => {
    const e = new Error("operation aborted");
    e.name = "AbortError";
    return e;
  };
  const runCurl = async (command, extra, signal) => {
    const request = Object.assign({ command, signal, timeoutMs: 3e4, stdoutMaxBytes: 4 * 1024 * 1024 }, extra || {});
    const execution = await ctx.shell.execute(ctx.shell.resolve(request));
    const result = await execution.result();
    if (result.aborted === true) throw abortedError();
    if (result.timedOut === true) throw new Error("request timed out");
    return result;
  };
  const htmlToText = (html) => {
    let s = String(html);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<[^>]*>/g, " ");
    s = s.replace(/&nbsp;/gi, " ");
    s = s.replace(/&amp;/gi, "&");
    s = s.replace(/&lt;/gi, "<");
    s = s.replace(/&gt;/gi, ">");
    s = s.replace(/&quot;/gi, '"');
    s = s.replace(/&#39;/g, "'");
    s = s.replace(/&#x27;/gi, "'");
    s = s.replace(/[ \t]{2,}/g, " ");
    s = s.replace(/ ?\n ?/g, "\n");
    s = s.replace(/\n{2,}/g, "\n");
    return s.trim();
  };
  const fetchPage = async (url, signal) => {
    if (typeof url !== "string" || /^https?:\/\//i.test(url) !== true) {
      throw new Error("url must be an absolute http(s) URL");
    }
    if (signal != null && signal.aborted === true) throw abortedError();
    const marker = "\n__DSH_FETCH_STATUS__:";
    const command = "curl -sSL --max-time 25 -A " + esc("Mozilla/5.0 (compatible; DSH-web-fetch/1.0)") + " -w " + esc(marker + "%{http_code}") + " " + esc(url);
    const result = await runCurl(command, {}, signal);
    const raw = result.stdout ? result.stdout.text : "";
    const idx = raw.lastIndexOf(marker);
    if (idx < 0) throw new Error("curl returned no status marker (output truncated?)");
    const statusCode = Number(raw.slice(idx + marker.length).trim());
    if (Number.isFinite(statusCode) !== true || statusCode === 0) {
      const detail = result.stderr && result.stderr.text ? String(result.stderr.text).slice(-400) : "";
      throw new Error("curl could not connect: " + detail);
    }
    const bodyRaw = raw.slice(0, idx);
    const isHtml = /<html[\s>]/i.test(bodyRaw) || /<!doctype html/i.test(bodyRaw);
    const text = isHtml ? htmlToText(bodyRaw) : bodyRaw;
    const limit = 2e4;
    return {
      url,
      statusCode,
      body: { kind: isHtml ? "html" : "text", content: text.slice(0, limit) },
      truncated: result.stdout.truncated === true || text.length > limit
    };
  };
  const tavilyErrorDetail = (data, statusCode) => {
    const detail = data != null ? data.detail : void 0;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (detail != null) {
      if (typeof detail.error === "string" && detail.error.length > 0) return detail.error;
      if (typeof detail.message === "string" && detail.message.length > 0) return detail.message;
    }
    if (data != null && typeof data.error === "string" && data.error.length > 0) return data.error;
    if (data != null && typeof data.message === "string" && data.message.length > 0) return data.message;
    if (statusCode === 401) return "invalid or revoked API key (check TAVILY_API_KEY)";
    if (statusCode === 429) return "rate limit exceeded; retry later";
    if (statusCode === 432) return "this request exceeds your plan's set usage limit (see https://api.tavily.com/usage)";
    return "unexpected response: " + JSON.stringify(data).slice(0, 200);
  };
  const conf = config != null && typeof config === "object" ? config : {};
  const fingerprint = (key) => {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
    }
    return h.toString(16);
  };
  const maskKey = (key) => key.length <= 8 ? "****" : key.slice(0, 10) + "…" + key.slice(-4);
  const pool = [];
  {
    const refs = Array.isArray(conf.keyRefs) ? conf.keyRefs : DEFAULT_KEY_REFS;
    const seen = /* @__PURE__ */ new Set();
    for (const raw of refs) {
      const ref = raw == null ? "" : String(raw).trim();
      if (ref.length === 0 || seen.has(ref)) continue;
      seen.add(ref);
      pool.push({ id: ref, ref });
    }
    const literals = Array.isArray(conf.apiKeys) ? conf.apiKeys : [];
    for (let i = 0; i < literals.length; i++) {
      const value = literals[i] == null ? "" : String(literals[i]).trim();
      if (value.length === 0) continue;
      pool.push({ id: "config.apiKeys[" + String(i) + "] " + maskKey(value), literal: value });
    }
  }
  const cooldownSeconds = Number(conf.cooldownSeconds);
  const cooldownMs = Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0 ? cooldownSeconds * 1e3 : 9e5;
  const bench = /* @__PURE__ */ new Map();
  let cursor = 0;
  const resolveKey = async (entry) => {
    if (entry.literal !== void 0) return entry.literal;
    try {
      const hit = await ctx.credentials.resolve(entry.ref);
      const value = hit != null && hit.value != null ? String(hit.value) : "";
      return value.length > 0 ? value : void 0;
    } catch (e) {
      return void 0;
    }
  };
  const holding = (entry, fp) => {
    const state = bench.get(entry.id);
    if (state === void 0) return false;
    if (state.fingerprint !== fp) {
      bench.delete(entry.id);
      return false;
    }
    return state.permanent === true || Date.now() < state.until;
  };
  const benchEntry = (entry, fp, code) => {
    bench.set(entry.id, {
      until: Date.now() + cooldownMs,
      permanent: code === 401,
      fingerprint: fp
    });
  };
  const attemptOrder = () => {
    const out = [];
    for (let i = 0; i < pool.length; i++) out.push(pool[(cursor + i) % pool.length]);
    return out;
  };
  const RETRYABLE_STATUS = /* @__PURE__ */ new Set([401, 403, 429, 432]);
  const searchWithKey = async (key, query, limit, signal) => {
    const payload = JSON.stringify({ query: String(query), max_results: limit, search_depth: "basic" });
    const marker = "\n__DSH_TAVILY_STATUS__:";
    const command = 'curl -sS --max-time 25 -X POST https://api.tavily.com/search -H "Content-Type: application/json" -H "Authorization: Bearer $TAVILY_API_KEY" -w ' + esc(marker + "%{http_code}") + " --data-binary " + esc(payload);
    const result = await runCurl(command, { env: { TAVILY_API_KEY: key } }, signal);
    if (result.exitCode !== 0) {
      const detail = result.stderr && result.stderr.text ? String(result.stderr.text).slice(-400) : "";
      throw new Error("tavily search failed (exit " + String(result.exitCode) + "): " + detail);
    }
    const raw = result.stdout && result.stdout.text ? String(result.stdout.text) : "";
    const idx = raw.lastIndexOf(marker);
    if (idx < 0) throw new Error("tavily search: curl returned no status marker (output truncated?)");
    const statusCode = Number(raw.slice(idx + marker.length).trim());
    const bodyText = raw.slice(0, idx);
    if (Number.isFinite(statusCode) !== true || statusCode === 0) {
      const detail = result.stderr && result.stderr.text ? String(result.stderr.text).slice(-400) : "";
      throw new Error("tavily search could not connect: " + detail);
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      throw new Error("tavily returned non-JSON (HTTP " + String(statusCode) + "): " + bodyText.slice(-200));
    }
    if (statusCode >= 400) {
      return {
        ok: false,
        statusCode,
        reason: tavilyErrorDetail(data, statusCode),
        retryable: RETRYABLE_STATUS.has(statusCode)
      };
    }
    const all = Array.isArray(data.results) ? data.results : [];
    const sources = all.slice(0, limit).map((r) => {
      const out2 = { url: String(r.url) };
      if (r.title != null && String(r.title).length > 0) out2.title = String(r.title);
      if (r.content != null && String(r.content).length > 0) out2.snippet = String(r.content).slice(0, 600);
      if (r.published_date != null && String(r.published_date).length > 0) out2.publishedAt = String(r.published_date);
      return out2;
    });
    const out = { sources, truncated: all.length > limit };
    if (data.answer != null && String(data.answer).length > 0) out.content = String(data.answer);
    return { ok: true, value: out };
  };
  const tavilySearch = async (query, maxResults, signal) => {
    if (signal != null && signal.aborted === true) throw abortedError();
    if (pool.length === 0) {
      throw new Error("tavily search: the key pool is empty — declare config.keyRefs (e.g. [TAVILY_API_KEY, TAVILY_API_KEY_2]) or config.apiKeys on the tavily-web row.");
    }
    const limit = Math.min(Math.max(Number(maxResults) || 5, 1), 20);
    const attempts = [];
    const deferred = [];
    const attempt = async (entry, key, lastResort) => {
      if (signal != null && signal.aborted === true) throw abortedError();
      const outcome = await searchWithKey(key, query, limit, signal);
      if (outcome.ok === true) {
        bench.delete(entry.id);
        cursor = (pool.indexOf(entry) + 1) % pool.length;
        return { value: outcome.value };
      }
      if (outcome.retryable !== true) {
        throw new Error("tavily search failed (HTTP " + String(outcome.statusCode) + "): " + outcome.reason);
      }
      benchEntry(entry, fingerprint(key), outcome.statusCode);
      attempts.push({
        id: entry.id,
        outcome: "HTTP " + String(outcome.statusCode),
        reason: outcome.reason,
        lastResort,
        retryableAt: outcome.statusCode === 401 ? void 0 : new Date(Date.now() + cooldownMs)
      });
      return void 0;
    };
    for (const entry of attemptOrder()) {
      const key = await resolveKey(entry);
      if (key === void 0) {
        attempts.push({ id: entry.id, outcome: "not configured" });
        continue;
      }
      if (holding(entry, fingerprint(key))) {
        deferred.push({ entry, key });
        continue;
      }
      const done = await attempt(entry, key, false);
      if (done !== void 0) return done.value;
    }
    for (const item of deferred) {
      const done = await attempt(item.entry, item.key, true);
      if (done !== void 0) return done.value;
    }
    if (attempts.every((a) => a.outcome === "not configured")) {
      throw new Error(
        "tavily search: no key is configured for the pool (" + pool.map((e) => e.id).join(", ") + '). Add e.g. "TAVILY_API_KEY: <tvly-...>" to ~/.dsh/.credentials.yaml, or declare config.keyRefs / config.apiKeys on the tavily-web row.'
      );
    }
    const lines = attempts.map((a) => {
      const retry = a.retryableAt !== void 0 ? " (retry after " + a.retryableAt.toISOString() + ")" : "";
      const tag = a.lastResort === true ? " [last resort]" : "";
      return "  - " + a.id + ": " + a.outcome + (a.reason !== void 0 ? " — " + a.reason : "") + retry + tag;
    });
    throw new Error("tavily search: all " + String(pool.length) + " key(s) in the pool failed\n" + lines.join("\n"));
  };
  ctx.web.registerFetchProvider({
    id: "dsh-curl-fetch",
    available: () => true,
    fetch: (request, signal) => fetchPage(request.url, signal)
  });
  ctx.tools.register(defineTool({
    name: "tavily_search",
    description: "Search the web through the Tavily API. Returns ranked sources with url/title/snippet and an optional short answer. Keys are rotated across a pool, so one exhausted account does not disable the tool.",
    parameters: {
      query: { type: "string", required: true, description: "The search query." },
      max_results: { type: "integer", description: "Number of sources to return, 1-20 (default 5)." }
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      return tavilySearch(String(args.query), args.max_results, exec.signal);
    }
  }));
  ctx.tools.register(defineTool({
    name: "web_fetch",
    description: "Fetch one web page through the curl fetch provider and return its HTTP status plus extracted text.",
    parameters: {
      url: { type: "string", required: true, description: "Absolute http(s) URL to fetch." }
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      return ctx.web.fetch({ url: String(args.url) }, exec.signal);
    }
  }));
  const configured = pool.length;
  console.log(
    "[tavily-web] registered tavily_search / web_fetch + curl fetch provider (key pool: " + String(configured) + " ref(s), cooldown " + String(Math.round(cooldownMs / 1e3)) + "s)"
  );
}
export {
  Config,
  apply,
  inject,
  name
};
