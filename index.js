/**
 * `dsh-web-search-opencode-ds` — a DSH `WebSearchProvider` (id `opencode-ds`)
 * that runs DeepSeek's official server-side web search through OpenCode's
 * Anthropic-compatible Messages endpoint. `goMode` chooses which OpenCode plan
 * that is: the flat-rate Go subscription (`/zen/go/v1`, the default) or the
 * default metered API (`/zen/v1`).
 *
 * ## What was verified against the live endpoint (2026-10-02)
 *
 * | Observation | Result |
 * |---|---|
 * | `POST https://opencode.ai/zen/go/v1/messages`, `model: deepseek-v4-flash`, tool `web_search_20250305` | **HTTP 200**, real `web_search_tool_result` blocks |
 * | same request **without** `x-opencode-session` | **HTTP 400** `{"type":"error","error":{"type":"MissingSessionID",...}}` |
 * | `Authorization: Bearer <key>` **only** (no `x-api-key`) | **HTTP 401** `AuthError: Missing API key.` |
 * | `x-api-key: <key>` only | **HTTP 200** |
 * | `GET /zen/go/v1/models` | 200; `deepseek-v4-flash` is a listed id |
 * | candidate session-creation paths (`/sessions`, `/session`, ...) | all **404** — there is no session-creation endpoint |
 *
 * Consequences baked into this implementation:
 *
 * 1. **`x-opencode-session` is mandatory** and is *client-generated*. The provider
 *    sends a fresh UUID v4 per search by default (`sessionMode: 'per-request'`);
 *    `'stable'` reuses one id for every search. There is no registration call and
 *    no response field carrying a session id, so the "create a session first"
 *    branch does not exist to take.
 * 2. **`x-api-key` is the header that actually authenticates.** The task spec asked
 *    for `Authorization: Bearer` only; sending that alone is rejected with 401.
 *    Both headers are sent so the provider survives either gateway behaviour.
 * 3. `web_search_result` items carry `title`, `url` and `page_age` (plus an opaque
 *    `encrypted_content`), but **no inline excerpt**. Snippets are therefore joined
 *    from `citations[].cited_text` when a deployment emits them, and omitted
 *    otherwise rather than being fabricated.
 *
 * ## Settings page
 *
 * The plugin declares a `Config` schema whose editable fields are `.volatile()`,
 * which is exactly what makes them show up in Settings → Plugins → this plugin
 * and survive a live edit. `client.js` (the browser half, declared through
 * `dsh.client` in package.json) draws the form.
 *
 * ## `@deepseek-ai/*` imports
 *
 * DSH's own packages do not resolve from a DSH profile directory, so a
 * profile-installed plugin cannot `import '@deepseek-ai/dsh-web'`. This package
 * therefore only imports `@deepseek-ai/schemastery`, which is a public npm
 * package (MIT) installed into this package's own `node_modules` — the one
 * import Node resolves relative to this file.
 *
 * @module dsh-web-search-opencode-ds
 */

import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name used by loader diagnostics and as the settings namespace. */
export const name = 'web-search-opencode-ds';

/** The web seam this provider registers into. */
export const inject = ['web'];

/** Stable provider id this plugin registers under. */
export const PROVIDER_ID = 'opencode-ds';

/** Settings namespace this plugin's form edits (the Loader row id, not the package name). */
export const SETTINGS_NAMESPACE = name;

/** The shipped provider this one can defer to when `overrideOfficial` is off. */
export const OFFICIAL_PROVIDER_ID = 'deepseek-official';

/**
 * OpenCode Go base: a flat-rate subscription plan. `/messages` is appended.
 * This is the endpoint the provider used before the mode switch existed.
 */
export const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * OpenCode Zen base: the default metered (pay-as-you-go) API. Verified to serve
 * the same catalog shape as Go (`/zen/v1/models` → 85 ids vs Go's 43), and
 * `deepseek-v4-flash` is present in both. A request here bills the account
 * balance instead of the Go plan, so it answers HTTP 402 "Insufficient account
 * funds" until the account is topped up — a configuration fact, not a bug in
 * this plugin.
 */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

/** Back-compat alias: the base used when `goMode` is on. */
export const DEFAULT_BASE_URL = GO_BASE_URL;

/** Default Anthropic-format model id (verified present in `/zen/go/v1/models`). */
export const DEFAULT_MODEL = 'deepseek-v4-flash';

/** Default `anthropic-version` header value. */
export const DEFAULT_API_VERSION = '2023-06-01';

/** Default upper bound on generated tokens for the Messages request. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Default maximum `web_search` server-tool uses per request. */
export const DEFAULT_MAX_USES = 5;

/** Default per-attempt timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of retries after the first attempt (so 2 attempts total). */
export const DEFAULT_RETRIES = 1;

/** Primary credential reference. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY';

/** Secondary credential reference, kept so an existing OpenCode Go key still resolves. */
export const FALLBACK_API_KEY_ENV = 'OPENCODE_GO_API_KEY';

/** Attribution header sent on every request. */
export const USER_AGENT = 'dsh-web-search-opencode-ds/0.2.0';

/** Prompt template; `{query}` is replaced with the caller's query. */
export const DEFAULT_QUERY_TEMPLATE = 'Perform a web search for the query: {query}';

/** Default session-id strategy: one fresh UUID v4 per search. */
export const DEFAULT_SESSION_MODE = 'per-request';

/** Default for `goMode`: on, i.e. bill the OpenCode Go plan. */
export const DEFAULT_GO_MODE = true;

/** Default for `overrideOfficial`: on, i.e. this plugin answers instead of the shipped provider. */
export const DEFAULT_OVERRIDE_OFFICIAL = true;

/**
 * The row's Config schema.
 *
 * `.volatile()` is what publishes a field to the settings form: DSH projects the
 * volatile fields of an active profile entry into a form namespace, and the
 * settings service persists edits through the profile's Cordis patch. Fields
 * left non-volatile stay load-time config, editable only in `cordis.patch.yml`.
 *
 * The schema must name every key the bundle patch sets — a patch REPLACES the
 * whole `config` of its target row, so anything absent here would be dropped or
 * rejected at load.
 */
export const Config = z.object({
  /** Literal key. Wins over the credential reference; never persisted by the form. */
  apiKey: z.string().role('secret').volatile(),
  /** Credential reference resolved through `ctx.credentials`, then the environment. */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  /** Explicit endpoint base. Blank means "derive from `goMode`". */
  baseURL: z.string().volatile(),
  /** Anthropic-format model id. */
  model: z.string().default(DEFAULT_MODEL).volatile(),
  /** `anthropic-version` header value. */
  apiVersion: z.string().default(DEFAULT_API_VERSION).volatile(),
  /** Upper bound on generated tokens. */
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  /** Upper bound on server-side searches per request. */
  maxUses: z.number().step(1).min(1).default(DEFAULT_MAX_USES).volatile(),
  /** Per-attempt timeout. */
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS).volatile(),
  /** Retries after the first attempt. */
  retries: z.number().step(1).min(0).default(DEFAULT_RETRIES),
  /** Session-id strategy. */
  sessionMode: z.union(['per-request', 'stable']).default(DEFAULT_SESSION_MODE),
  /** Prompt template; `{query}` is substituted. */
  queryTemplate: z.string().default(DEFAULT_QUERY_TEMPLATE),
  /** Expose the model's prose answer as the result's `content`. */
  includeAnswer: z.boolean().default(false).volatile(),
  /**
   * `true` (default): use the OpenCode endpoint configured here — this plugin
   * overrides the shipped provider's configuration.
   * `false`: leave the official provider's configuration in charge by
   * delegating every search to `deepseek-official`, unchanged.
   */
  overrideOfficial: z.boolean().default(DEFAULT_OVERRIDE_OFFICIAL).volatile(),
  /**
   * `true` (default): the OpenCode Go flat-rate plan endpoint (`/zen/go/v1`).
   * `false`: the default metered API (`/zen/v1`), billed per use.
   */
  goMode: z.boolean().default(DEFAULT_GO_MODE).volatile(),
});

/** HTTP statuses worth one more attempt. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Stable, machine-routable error carrying the seam's error vocabulary. */
export class WebSearchError extends Error {
  /**
   * @param {string} message - human-readable detail.
   * @param {string} code - stable code, e.g. `WEB_PROVIDER_CREDENTIAL_MISSING`.
   * @param {{ cause?: unknown, retryable?: boolean }} [options] - cause and retry hint.
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WebSearchError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

/**
 * Read one config value, tolerating both a plain value and a schemastery
 * "volatile" reference (which exposes `.get()`), so this plugin behaves the same
 * whether or not a Config schema ever wraps the row.
 *
 * @param {unknown} config - the row config handed to `apply`.
 * @param {string} key - field name.
 * @param {unknown} fallback - value used when the field is absent or null.
 * @returns {unknown} the resolved value.
 */
function readOption(config, key, fallback) {
  if (config === null || config === undefined) return fallback;
  let value;
  try {
    value = config[key];
  } catch {
    return fallback;
  }
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const live = value.get();
      return live === undefined || live === null ? fallback : live;
    } catch {
      return fallback;
    }
  }
  return value;
}

/** True for a positive integer. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** True for a non-negative integer. */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** True when `value` parses as an absolute URL. */
function isParsableUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (typeof URL.canParse === 'function') return URL.canParse(value);
  try {
    void new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Read a non-empty environment variable, or undefined. */
function envValue(key) {
  if (typeof key !== 'string' || key.length === 0) return undefined;
  const value = process.env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Build the `url → cited_text` map used to attach snippets. */
export function citationSnippets(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    const citations = Array.isArray(block.citations) ? block.citations : [];
    for (const citation of citations) {
      const url = typeof citation?.url === 'string' ? citation.url : '';
      const text = typeof citation?.cited_text === 'string' ? citation.cited_text : '';
      if (url.length > 0 && text.length > 0 && !map.has(url)) map.set(url, text);
    }
  }
  return map;
}

/** First non-empty string among the candidates. */
function firstNonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Concatenate every `text` block, or undefined when there is no prose. */
export function answerText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/**
 * Build the Anthropic Messages body for one search.
 *
 * `content` is sent as a block array rather than a bare string: both shapes work
 * for `deepseek-v4-flash`, but the array form is the one DeepSeek's Anthropic
 * surface documents and it avoids the `Empty input messages` class of 400.
 *
 * @param {{ model: string, maxTokens: number, maxUses: number, queryTemplate: string }} options - resolved options.
 * @param {string} query - the caller's query.
 * @returns {object} the JSON request body.
 */
export function buildSearchBody(options, query) {
  const prompt = options.queryTemplate.includes('{query}')
    ? options.queryTemplate.split('{query}').join(query)
    : `${options.queryTemplate}${query}`;
  return {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    ],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: options.maxUses,
      },
    ],
  };
}

/**
 * Map a DeepSeek/Anthropic Messages response to the seam's search result.
 *
 * Walks `web_search_tool_result` blocks for `web_search_result` items, joins each
 * to its citation excerpt when one exists, and dedupes by URL (a `max_uses > 1`
 * request can surface the same URL across searches). The web seam owns the final
 * `maxResults` truncation, so `truncated` is always `false` here.
 *
 * @param {object} response - the parsed Messages response body.
 * @param {{ includeAnswer?: boolean }} [options] - whether to surface model prose as `content`.
 * @returns {{ content?: string, sources: object[], truncated: boolean }} the normalized result.
 * @throws {WebSearchError} `WEB_PROVIDER_ERROR` when the response carries no result block.
 */
export function mapAnthropicResponse(response, options = {}) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new WebSearchError(
      'OpenCode returned no web_search_tool_result blocks; the request may not have triggered native web search. ' +
        'Check that the configured model supports the web_search_20250305 server tool.',
      'WEB_PROVIDER_ERROR',
    );
  }

  const snippets = citationSnippets(blocks);
  const seen = new Set();
  const sources = [];
  for (const block of resultBlocks) {
    const items = Array.isArray(block?.content) ? block.content : [];
    for (const item of items) {
      if (item?.type !== 'web_search_result') continue;
      const url = typeof item.url === 'string' ? item.url : '';
      if (url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      const title = firstNonEmptyString(item.title);
      const snippet = firstNonEmptyString(
        snippets.get(url),
        item.snippet,
        item.text,
        item.description,
      );
      const publishedAt = firstNonEmptyString(item.page_age, item.published_at);
      sources.push({
        url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      });
    }
  }

  const answer = options.includeAnswer === true ? answerText(blocks) : undefined;
  return {
    ...(answer === undefined ? {} : { content: answer }),
    sources,
    truncated: false,
  };
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new WebSearchError('OpenCode web search aborted', 'WEB_ABORTED', {
      cause: signal.reason,
    });
  }
}

/**
 * Race one attempt's timeout against the caller's cancellation without depending
 * on `AbortSignal.any` (so the plugin also runs on older hosts).
 *
 * @param {AbortSignal | undefined} callerSignal - the caller's signal.
 * @param {number} timeoutMs - per-attempt budget.
 * @returns {{ signal: AbortSignal, didTimeout: () => boolean, cleanup: () => void }} the attempt signal.
 */
function createAttemptSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`OpenCode web search timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal !== undefined) {
    if (callerSignal.aborted === true) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal !== undefined) callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** Abortable delay between attempts. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new WebSearchError('OpenCode web search aborted', 'WEB_ABORTED', { cause: signal.reason }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new WebSearchError('OpenCode web search aborted', 'WEB_ABORTED', { cause: signal?.reason }));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Extract the most useful message from an Anthropic-style error body. */
function errorDetail(parsed) {
  const error = parsed?.error;
  if (typeof error === 'string' && error.length > 0) return error;
  if (typeof error?.message === 'string' && error.message.length > 0) return error.message;
  if (typeof parsed?.message === 'string' && parsed.message.length > 0) return parsed.message;
  return undefined;
}

/** True when a non-2xx body names the missing-session condition. */
function isMissingSession(parsed) {
  const type = parsed?.error?.type;
  if (typeof type === 'string' && /MissingSessionID/i.test(type)) return true;
  return /MissingSessionID/i.test(JSON.stringify(parsed ?? ''));
}

/**
 * The OpenCode search provider.
 *
 * Options are re-resolved per operation (a thunk rather than a snapshot) so a
 * config change reaches the next search without re-registering the provider,
 * which would make the seam's selection observable as a flicker.
 */
export class OpenCodeSearchProvider {
  /**
   * @param {object} ctx - the plugin context.
   * @param {() => object} resolveOptions - resolves the options for the next operation.
   */
  constructor(ctx, resolveOptions) {
    this.ctx = ctx;
    this.resolveOptions = resolveOptions;
    this.id = PROVIDER_ID;
    /** Reused across searches when `sessionMode` is `stable`. */
    this.stableSessionId = randomUUID();
  }

  /**
   * Cheap local availability check — never makes a network call. A mounted
   * credentials service is treated optimistically, exactly like the shipped
   * provider: the search itself fails with `WEB_PROVIDER_CREDENTIAL_MISSING`
   * when the reference turns out to be unset.
   *
   * @returns {boolean} whether this provider can plausibly run a search.
   */
  available() {
    const options = this.resolveOptions();
    // "Do not override the official configuration" makes this provider a
    // pass-through: it is only usable while the official one is.
    if (!options.overrideOfficial) return officialProvider(this.ctx)?.available() === true;
    if (!isParsableUrl(options.baseURL)) return false;
    if (!isPositiveInteger(options.maxTokens)) return false;
    if (!isPositiveInteger(options.maxUses)) return false;
    if (typeof options.model !== 'string' || options.model.length === 0) return false;
    if (typeof options.apiKey === 'string' && options.apiKey.length > 0) return true;
    for (const ref of credentialRefs(options)) {
      if (envValue(ref) !== undefined) return true;
    }
    return this.ctx.get('credentials') !== undefined;
  }

  /**
   * Resolve one operation's API key. Never cached, so a rotated key reaches the
   * next search without a restart.
   *
   * @param {object} options - the operation's option snapshot.
   * @param {AbortSignal | undefined} signal - the caller's signal.
   * @returns {Promise<string>} the API key.
   * @throws {WebSearchError} `WEB_PROVIDER_CREDENTIAL_MISSING` when none resolves.
   */
  async resolveApiKey(options, signal) {
    throwIfAborted(signal);
    if (typeof options.apiKey === 'string' && options.apiKey.length > 0) return options.apiKey;

    // Both references are tried against the credential store, not just the
    // primary one. The plugin's canonical reference is `OPENCODE_API_KEY`, but a
    // key stored under the pre-rename name must keep working — otherwise
    // renaming the plugin silently locks every existing install out of search.
    const refs = credentialRefs(options);
    const credentials = this.ctx.get('credentials');
    if (credentials !== undefined) {
      for (const ref of refs) {
        try {
          const resolved = await credentials.resolve(ref);
          if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
        } catch {
          // Fall through to the next reference, then the process environment.
        }
        throwIfAborted(signal);
      }
    }

    for (const ref of refs) {
      const fromEnv = envValue(ref);
      if (fromEnv !== undefined) return fromEnv;
    }

    throw new WebSearchError(
      `OpenCode web search has no API key: store it in the DSH credential store under ` +
        `${refs.map((ref) => `"${ref}"`).join(' or ')}, set the matching environment variable, ` +
        `or set a literal "apiKey" in the web-search-opencode-ds config.`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    );
  }

  /**
   * Run one search through OpenCode.
   *
   * @param {{ query: string, maxResults?: number }} request - the seam's request.
   * @param {AbortSignal} [signal] - optional cancellation signal.
   * @returns {Promise<{ content?: string, sources: object[], truncated: boolean }>} normalized results.
   */
  async search(request, signal) {
    const options = this.resolveOptions();
    // Pass-through mode: hand the request to the shipped provider so its
    // endpoint, key, model and search budget all apply unchanged.
    if (!options.overrideOfficial) {
      const provider = officialProvider(this.ctx);
      if (provider === undefined) {
        throw new WebSearchError(
          `"${SETTINGS_NAMESPACE}" is set to not override the official configuration, but the ` +
            `"${OFFICIAL_PROVIDER_ID}" provider is not registered, so there is nothing to defer to. ` +
            `Re-enable "Override official configuration", or mount @deepseek-ai/dsh-web-search-deepseek.`,
          'WEB_PROVIDER_ERROR',
        );
      }
      return provider.search(request, signal);
    }

    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/messages`;
    const apiKey = await this.resolveApiKey(options, signal);
    const body = buildSearchBody(options, request.query);
    const attempts = options.retries + 1;

    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      if (attempt > 0) await delay(500 * attempt, signal);
      try {
        return await this.attempt(endpoint, apiKey, options, body, signal);
      } catch (error) {
        lastError = error;
        if (!(error instanceof WebSearchError) || error.retryable !== true || attempt === attempts - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /**
   * One dispatch attempt.
   *
   * @param {string} endpoint - the resolved Messages endpoint.
   * @param {string} apiKey - the resolved key.
   * @param {object} options - the operation's option snapshot.
   * @param {object} body - the request body.
   * @param {AbortSignal | undefined} callerSignal - the caller's signal.
   * @returns {Promise<object>} the normalized search result.
   */
  async attempt(endpoint, apiKey, options, body, callerSignal) {
    const sessionId =
      typeof options.sessionId === 'string' && options.sessionId.length > 0
        ? options.sessionId
        : options.sessionMode === 'stable'
          ? this.stableSessionId
          : randomUUID();

    const attemptSignal = createAttemptSignal(callerSignal, options.timeoutMs);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          // Verified: `x-api-key` is what authenticates on OpenCode;
          // `Authorization: Bearer` alone answers 401 `Missing API key.`
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'anthropic-version': options.apiVersion,
          'x-opencode-session': sessionId,
          'x-opencode-client': 'dsh',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: attemptSignal.signal,
      });
    } catch (error) {
      if (callerSignal?.aborted === true) {
        throw new WebSearchError('OpenCode web search aborted', 'WEB_ABORTED', {
          cause: callerSignal.reason,
        });
      }
      if (attemptSignal.didTimeout()) {
        throw new WebSearchError(
          `OpenCode web search timed out after ${options.timeoutMs}ms at ${JSON.stringify(endpoint)}.`,
          'WEB_PROVIDER_ERROR',
          { cause: error, retryable: true },
        );
      }
      throw new WebSearchError(
        `OpenCode web search request failed: ${String(error)}\n\nThe request used endpoint ${JSON.stringify(endpoint)}.`,
        'WEB_PROVIDER_ERROR',
        { cause: error, retryable: true },
      );
    } finally {
      attemptSignal.cleanup();
    }

    if (!response.ok) {
      const status = response.status;
      let parsed;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      const detail = errorDetail(parsed);
      const suffix = detail === undefined ? '' : `: ${detail}`;

      if (status === 400 && isMissingSession(parsed)) {
        throw new WebSearchError(
          `OpenCode rejected the search (HTTP 400) because the request carried no usable ` +
            `x-opencode-session header${suffix}. This provider generates one per search; seeing this ` +
            `means the header was stripped in transit.`,
          'WEB_PROVIDER_ERROR',
          { retryable: true },
        );
      }
      if (status === 401 || status === 403) {
        throw new WebSearchError(
          `OpenCode rejected the credential (HTTP ${status})${suffix}. Check that ${options.apiKeyEnv} ` +
            `holds a valid OpenCode key that is entitled to the ` +
            `${options.goMode ? 'OpenCode Go subscription' : 'metered OpenCode Zen API'} ` +
            `currently selected by goMode.`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        );
      }
      if (status === 402) {
        throw new WebSearchError(
          `OpenCode refused the search for lack of funds (HTTP 402)${suffix}\n\n` +
            `goMode is off, so this request went to the metered endpoint ${JSON.stringify(endpoint)}. ` +
            `Add funds to the account, or switch goMode back on to bill the flat-rate Go plan instead.`,
          'WEB_PROVIDER_ERROR',
        );
      }
      throw new WebSearchError(
        `OpenCode API error (HTTP ${status})${suffix}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}.`,
        'WEB_PROVIDER_ERROR',
        { retryable: RETRYABLE_STATUS.has(status) },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new WebSearchError(
        `OpenCode returned an unprocessable response body: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error, retryable: true },
      );
    }

    return mapAnthropicResponse(payload, { includeAnswer: options.includeAnswer === true });
  }
}

/**
 * Project the live config into the options one search runs with. Every value is
 * fully defaulted here so the provider never reads a raw config field.
 *
 * @param {object} ctx - the plugin context.
 * @param {unknown} config - the row config.
 * @returns {object} the resolved options.
 */
export function resolveOptions(ctx, config) {
  const goMode = readOption(config, 'goMode', DEFAULT_GO_MODE) !== false;
  const declaredBaseUrl = readOption(config, 'baseURL', undefined);
  return {
    apiKey: readOption(config, 'apiKey', undefined),
    apiKeyEnv: readOption(config, 'apiKeyEnv', DEFAULT_API_KEY_ENV),
    // An explicit baseURL always wins; otherwise the mode picks the endpoint.
    baseURL:
      typeof declaredBaseUrl === 'string' && declaredBaseUrl.length > 0
        ? declaredBaseUrl
        : goMode
          ? GO_BASE_URL
          : ZEN_BASE_URL,
    model: readOption(config, 'model', DEFAULT_MODEL),
    apiVersion: readOption(config, 'apiVersion', DEFAULT_API_VERSION),
    maxTokens: readOption(config, 'maxTokens', DEFAULT_MAX_TOKENS),
    maxUses: readOption(config, 'maxUses', DEFAULT_MAX_USES),
    timeoutMs: readOption(config, 'timeoutMs', DEFAULT_TIMEOUT_MS),
    retries: readOption(config, 'retries', DEFAULT_RETRIES),
    queryTemplate: readOption(config, 'queryTemplate', DEFAULT_QUERY_TEMPLATE),
    sessionMode: readOption(config, 'sessionMode', DEFAULT_SESSION_MODE),
    sessionId: readOption(config, 'sessionId', undefined),
    includeAnswer: readOption(config, 'includeAnswer', false),
    goMode,
    overrideOfficial: readOption(config, 'overrideOfficial', DEFAULT_OVERRIDE_OFFICIAL) !== false,
  };
}

/**
 * The credential references to try, in order, for one operation.
 *
 * The configured reference comes first; the other canonical spelling is always
 * appended so a key stored under either name resolves. Duplicates are dropped.
 *
 * @param {object} options - the operation's option snapshot.
 * @returns {string[]} the references to try, most specific first.
 */
export function credentialRefs(options) {
  const configured = typeof options.apiKeyEnv === 'string' && options.apiKeyEnv.length > 0
    ? options.apiKeyEnv
    : DEFAULT_API_KEY_ENV;
  return [...new Set([configured, DEFAULT_API_KEY_ENV, FALLBACK_API_KEY_ENV])];
}

/**
 * Look up the shipped DeepSeek provider in the seam's own registry.
 *
 * `WebRuntime.searchProviders` is a plain public `Map`, and the seam resolves
 * the configured id at call time, so delegating here is a live decision: the
 * official provider keeps using its own section of config, which is exactly what
 * "do not override the official configuration" has to mean.
 *
 * @param {object} ctx - the plugin context.
 * @returns {{ search: Function, available: Function } | undefined} the official provider, if mounted.
 */
function officialProvider(ctx) {
  const web = ctx.get?.('web') ?? ctx.web;
  const registry = web?.searchProviders;
  if (!(registry instanceof Map)) return undefined;
  const provider = registry.get(OFFICIAL_PROVIDER_ID);
  return provider === undefined || provider === null ? undefined : provider;
}

/**
 * Register the OpenCode search provider with `ctx.web`.
 *
 * @param {object} ctx - the plugin context, carrying the `web` seam.
 * @param {unknown} config - the row config.
 */
export function apply(ctx, config) {
  const provider = new OpenCodeSearchProvider(ctx, () => {
    const options = resolveOptions(ctx, config);
    return {
      ...options,
      retries: isNonNegativeInteger(options.retries) ? options.retries : DEFAULT_RETRIES,
      timeoutMs: isPositiveInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    };
  });
  ctx.web.registerSearchProvider(provider);

  // This plugin ships its own browser form (`client.js`), so it opts out of the
  // schema-generated page. `auto: false` only suppresses that generation — the
  // settings service still serves reads and writes for the namespace. Registering
  // inside `ctx.inject(['settings'], ...)` keeps the plugin usable in a profile
  // that has no settings service at all, and ties the policy to this plugin's
  // fiber so a late-loaded Settings service still adopts it.
  ctx.inject?.(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'web-search-opencode-ds: settings presentation policy',
    );
  });

  const options = resolveOptions(ctx, config);
  ctx.logger?.debug?.(
    'web-search-opencode-ds: registered search provider "%s" (%s; mode=%s, overrideOfficial=%s)',
    PROVIDER_ID,
    provider.available() ? 'available' : 'unavailable (no credential yet)',
    options.goMode ? 'go' : 'metered',
    String(options.overrideOfficial),
  );
}
