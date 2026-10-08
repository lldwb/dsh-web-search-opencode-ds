// Parser and option tests for dsh-web-search-opencode-ds.
//
// Run with:  node --test test/
//
// The response fixture mirrors a real 2026-10-02 payload from
// POST https://opencode.ai/zen/go/v1/messages: `web_search_result` items carry
// title/url/page_age and an opaque `encrypted_content`, with no inline excerpt.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_USES,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  FALLBACK_API_KEY_ENV,
  GO_BASE_URL,
  OFFICIAL_PROVIDER_ID,
  PROVIDER_ID,
  SETTINGS_NAMESPACE,
  USER_AGENT,
  ZEN_BASE_URL,
  OpenCodeSearchProvider,
  WebSearchError,
  apply,
  buildSearchBody,
  citationSnippets,
  credentialRefs,
  mapAnthropicResponse,
  name,
  resolveOptions,
} from '../index.js';

/** A minimal successful payload shaped like the live one. */
function liveLikeResponse() {
  return {
    id: 'c1571262-7b34-4861-ba2f-f9abd1c78e6f',
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    model: 'deepseek-v4-flash',
    content: [
      { type: 'thinking', thinking: 'I should search.', signature: 'sig' },
      {
        type: 'server_tool_use',
        id: 'call_00_ihuFIjN975B3i5fvj3oo9661',
        name: 'web_search',
        input: { query: 'DeepSeek V4 Flash release date' },
        caller: { type: 'direct' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'call_00_ihuFIjN975B3i5fvj3oo9661',
        content: [
          {
            type: 'web_search_result',
            title: 'DeepSeek V4 released',
            url: 'https://example.com/a',
            encrypted_content: 'opaque-blob',
            page_age: null,
          },
          {
            type: 'web_search_result',
            title: 'DeepSeek returns with V4-Pro and V4-Flash',
            url: 'https://example.com/b',
            encrypted_content: 'opaque-blob-2',
            page_age: '2026-04-24',
          },
          // Duplicate URL: must be deduped.
          {
            type: 'web_search_result',
            title: 'DeepSeek V4 released (dup)',
            url: 'https://example.com/a',
            encrypted_content: 'opaque-blob-3',
            page_age: null,
          },
        ],
      },
      { type: 'text', text: 'DeepSeek V4 Flash shipped on April 24, 2026.' },
    ],
    usage: { input_tokens: 2908, output_tokens: 597, server_tool_use: { web_search_requests: 1 } },
  };
}

test('buildSearchBody sends the native web_search server tool', () => {
  const body = buildSearchBody(
    { model: 'deepseek-v4-flash', maxTokens: 4096, maxUses: 5, queryTemplate: 'Perform a web search for the query: {query}' },
    'who won',
  );
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.tools, [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  ]);
  // Content is a block array, never a bare string.
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Perform a web search for the query: who won' },
  ]);
});

test('buildSearchBody appends the query when the template has no placeholder', () => {
  const body = buildSearchBody(
    { model: 'm', maxTokens: 1, maxUses: 1, queryTemplate: 'Search: ' },
    'x',
  );
  assert.equal(body.messages[0].content[0].text, 'Search: x');
});

test('mapAnthropicResponse extracts title/url/publishedAt and dedupes by url', () => {
  const result = mapAnthropicResponse(liveLikeResponse());
  assert.equal(result.truncated, false);
  assert.equal(result.content, undefined, 'prose is not surfaced by default');
  assert.equal(result.sources.length, 2, 'the duplicate url is dropped');
  assert.deepEqual(result.sources[0], { url: 'https://example.com/a', title: 'DeepSeek V4 released' });
  assert.deepEqual(result.sources[1], {
    url: 'https://example.com/b',
    title: 'DeepSeek returns with V4-Pro and V4-Flash',
    publishedAt: '2026-04-24',
  });
  // The opaque blob must never leak into the source list.
  assert.equal(JSON.stringify(result.sources).includes('opaque-blob'), false);
});

test('mapAnthropicResponse omits snippet when the deployment emits no citations', () => {
  const result = mapAnthropicResponse(liveLikeResponse());
  for (const source of result.sources) {
    assert.equal('snippet' in source, false, 'no snippet is invented');
  }
});

test('mapAnthropicResponse joins cited_text as the snippet when present', () => {
  const payload = liveLikeResponse();
  payload.content.push({
    type: 'text',
    text: 'Cited answer.',
    citations: [
      { type: 'web_search_result_location', url: 'https://example.com/a', cited_text: 'excerpt A' },
      { type: 'web_search_result_location', url: 'https://example.com/b', cited_text: 'excerpt B' },
    ],
  });
  const result = mapAnthropicResponse(payload);
  assert.equal(result.sources[0].snippet, 'excerpt A');
  assert.equal(result.sources[1].snippet, 'excerpt B');
});

test('citationSnippets keeps the first occurrence per url', () => {
  const map = citationSnippets([
    { type: 'text', citations: [{ url: 'u', cited_text: 'first' }] },
    { type: 'text', citations: [{ url: 'u', cited_text: 'second' }] },
    { type: 'text', citations: [{ url: 'v' }] },
  ]);
  assert.equal(map.get('u'), 'first');
  assert.equal(map.has('v'), false, 'a citation without cited_text contributes nothing');
});

test('mapAnthropicResponse surfaces the answer only when asked', () => {
  const result = mapAnthropicResponse(liveLikeResponse(), { includeAnswer: true });
  assert.equal(result.content, 'DeepSeek V4 Flash shipped on April 24, 2026.');
});

test('mapAnthropicResponse throws WEB_PROVIDER_ERROR without a result block', () => {
  assert.throws(
    () => mapAnthropicResponse({ content: [{ type: 'text', text: 'I did not search.' }] }),
    (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.equal(error.code, 'WEB_PROVIDER_ERROR');
      assert.match(error.message, /web_search_tool_result/);
      return true;
    },
  );
});

test('mapAnthropicResponse tolerates a malformed body', () => {
  assert.throws(() => mapAnthropicResponse(undefined), WebSearchError);
  assert.throws(() => mapAnthropicResponse({ content: 'nope' }), WebSearchError);
});

test('resolveOptions applies every documented default', () => {
  const options = resolveOptions({ get: () => undefined }, undefined);
  assert.equal(options.apiKeyEnv, DEFAULT_API_KEY_ENV);
  assert.equal(options.baseURL, DEFAULT_BASE_URL);
  assert.equal(options.model, DEFAULT_MODEL);
  assert.equal(options.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(options.maxUses, DEFAULT_MAX_USES);
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(options.retries, DEFAULT_RETRIES);
  assert.equal(options.sessionMode, 'per-request');
});

test('resolveOptions reads a plain config object', () => {
  const options = resolveOptions({ get: () => undefined }, {
    baseURL: 'https://example.test/v1',
    model: 'other-model',
    maxUses: 2,
    retries: 0,
  });
  assert.equal(options.baseURL, 'https://example.test/v1');
  assert.equal(options.model, 'other-model');
  assert.equal(options.maxUses, 2);
  assert.equal(options.retries, 0);
});

test('resolveOptions unwraps schemastery-style volatile references', () => {
  const options = resolveOptions({ get: () => undefined }, {
    baseURL: { get: () => 'https://from-ref.test/v1' },
    model: { get: () => 'ref-model' },
  });
  assert.equal(options.baseURL, 'https://from-ref.test/v1');
  assert.equal(options.model, 'ref-model');
});

test('provider id is the documented one', () => {
  const provider = new OpenCodeSearchProvider({ get: () => undefined }, () => resolveOptions({ get: () => undefined }, undefined));
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(PROVIDER_ID, 'opencode-ds');
});

test('available() is false without any credential, true with the env var', () => {
  const ctx = { get: () => undefined };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, undefined));

  const saved = process.env[DEFAULT_API_KEY_ENV];
  delete process.env[DEFAULT_API_KEY_ENV];
  delete process.env.OPENCODE_API_KEY;
  try {
    assert.equal(provider.available(), false, 'no key, no credentials service');
    process.env[DEFAULT_API_KEY_ENV] = 'sk-test';
    assert.equal(provider.available(), true);
  } finally {
    if (saved === undefined) delete process.env[DEFAULT_API_KEY_ENV];
    else process.env[DEFAULT_API_KEY_ENV] = saved;
  }
});

test('available() is optimistic when a credentials service is mounted', () => {
  const ctx = { get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined) };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, undefined));
  const saved = process.env[DEFAULT_API_KEY_ENV];
  delete process.env[DEFAULT_API_KEY_ENV];
  delete process.env.OPENCODE_API_KEY;
  try {
    assert.equal(provider.available(), true, 'resolution is deferred to search time');
  } finally {
    if (saved !== undefined) process.env[DEFAULT_API_KEY_ENV] = saved;
  }
});

test('available() rejects an unparseable baseURL and non-positive limits', () => {
  const ctx = { get: () => undefined };
  const make = (config) => new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, config));
  assert.equal(make({ baseURL: 'not a url', apiKey: 'k' }).available(), false);
  assert.equal(make({ maxTokens: 0, apiKey: 'k' }).available(), false);
  assert.equal(make({ maxUses: -1, apiKey: 'k' }).available(), false);
  assert.equal(make({ model: '', apiKey: 'k' }).available(), false);
  assert.equal(make({ apiKey: 'k' }).available(), true);
});

test('search() reports a missing credential with the stable code', async () => {
  const ctx = { get: () => undefined };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, undefined));
  const saved = process.env[DEFAULT_API_KEY_ENV];
  delete process.env[DEFAULT_API_KEY_ENV];
  delete process.env.OPENCODE_API_KEY;
  try {
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
        assert.match(error.message, /OPENCODE_API_KEY/);
        return true;
      },
    );
  } finally {
    if (saved !== undefined) process.env[DEFAULT_API_KEY_ENV] = saved;
  }
});

test('search() resolves the key from the credentials service first', async () => {
  const ctx = {
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'sk-from-store' }) } : undefined),
  };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, { baseURL: 'https://example.test/v1' }));
  assert.equal(await provider.resolveApiKey(resolveOptions(ctx, {}), undefined), 'sk-from-store');
});

test('search() falls back to the environment when the store has no value', async () => {
  const ctx = {
    get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined),
  };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, {}));
  const saved = process.env[DEFAULT_API_KEY_ENV];
  process.env[DEFAULT_API_KEY_ENV] = 'sk-from-env';
  try {
    assert.equal(await provider.resolveApiKey(resolveOptions(ctx, {}), undefined), 'sk-from-env');
  } finally {
    if (saved === undefined) delete process.env[DEFAULT_API_KEY_ENV];
    else process.env[DEFAULT_API_KEY_ENV] = saved;
  }
});

test('search() honours an already-aborted signal', async () => {
  const ctx = { get: () => undefined };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, { apiKey: 'sk-test' }));
  const controller = new AbortController();
  controller.abort(new Error('caller went away'));
  await assert.rejects(
    () => provider.search({ query: 'x' }, controller.signal),
    (error) => {
      assert.equal(error.code, 'WEB_ABORTED');
      return true;
    },
  );
});

test('search() sends both auth headers, a session id, and the tool block', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(liveLikeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () =>
      resolveOptions(ctx, { apiKey: 'sk-test', baseURL: 'https://opencode.ai/zen/go/v1' }),
    );
    const result = await provider.search({ query: 'deepseek v4' });

    assert.equal(calls.length, 1, 'one attempt on success');
    assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/messages');
    const headers = calls[0].init.headers;
    assert.equal(headers['x-api-key'], 'sk-test', 'x-api-key authenticates');
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['x-opencode-client'], 'dsh');
    assert.match(headers['user-agent'], /^dsh-web-search-opencode-ds\//);
    assert.match(
      headers['x-opencode-session'],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'a UUID v4 session id is generated per request',
    );
    assert.equal(calls[0].init.redirect, 'error');

    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    assert.equal(result.sources.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search() mints a fresh session id per request by default', async () => {
  const sessions = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sessions.push(init.headers['x-opencode-session']);
    return new Response(JSON.stringify(liveLikeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () =>
      resolveOptions(ctx, { apiKey: 'sk-test' }),
    );
    await provider.search({ query: 'a' });
    await provider.search({ query: 'b' });
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0], sessions[1], 'per-request mode does not reuse an id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search() reuses one session id in stable mode', async () => {
  const sessions = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sessions.push(init.headers['x-opencode-session']);
    return new Response(JSON.stringify(liveLikeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () =>
      resolveOptions(ctx, { apiKey: 'sk-test', sessionMode: 'stable' }),
    );
    await provider.search({ query: 'a' });
    await provider.search({ query: 'b' });
    assert.equal(sessions[0], sessions[1], 'stable mode keeps prompt-cache affinity');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search() retries once on a retryable status, then succeeds', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'OverloadedError', message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(liveLikeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, { apiKey: 'sk-test' }));
    const result = await provider.search({ query: 'x' });
    assert.equal(attempts, 2, 'one retry after the first attempt');
    assert.equal(result.sources.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search() does not retry an authentication failure', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'AuthError', message: 'Missing API key.' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, { apiKey: 'sk-bad' }));
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
        // The hint names the mode that was actually billed, so a 401 in Go mode
        // points at the subscription and a 401 in metered mode at the API key.
        assert.match(error.message, /OpenCode Go subscription/u);
        assert.match(error.message, /goMode/u);
        return true;
      },
    );
    assert.equal(attempts, 1, 'a bad key is not retried');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search() retries once on MissingSessionID and explains the header', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'MissingSessionID',
          message: 'Request is missing x-opencode-session and cannot be routed efficiently.',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, { apiKey: 'sk-test' }));
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.match(error.message, /x-opencode-session/);
        return true;
      },
    );
    assert.equal(attempts, 2, 'MissingSessionID gets one retry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apply() registers the provider with the web seam', () => {
  const registered = [];
  const ctx = {
    get: () => undefined,
    web: { registerSearchProvider: (provider) => { registered.push(provider); return () => {}; } },
  };
  apply(ctx, { apiKey: 'sk-test' });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'opencode-ds');
  assert.equal(registered[0].available(), true);
});

// ── identity ─────────────────────────────────────────────────────────────────
// The plugin is named for what it is (OpenCode + DeepSeek), not for the plan it
// happens to bill. "Go" is a switch, so it must not appear in any identity: the
// loader name, the provider id, the settings namespace, or the attribution
// header. The settings namespace in particular has to equal the Loader row id,
// or the browser form mounts against a namespace nobody serves.

test('identity carries no plan name', () => {
  assert.equal(name, 'web-search-opencode-ds');
  assert.equal(PROVIDER_ID, 'opencode-ds');
  assert.equal(SETTINGS_NAMESPACE, name);
  assert.equal(OFFICIAL_PROVIDER_ID, 'deepseek-official');
  for (const value of [name, PROVIDER_ID, SETTINGS_NAMESPACE, USER_AGENT]) {
    assert.doesNotMatch(value, /go/iu, `${value} must not name the Go plan`);
  }
});

// ── the Go / metered switch ──────────────────────────────────────────────────

test('goMode picks the endpoint, and an explicit baseURL still wins', () => {
  assert.equal(GO_BASE_URL, 'https://opencode.ai/zen/go/v1');
  assert.equal(ZEN_BASE_URL, 'https://opencode.ai/zen/v1');
  assert.equal(DEFAULT_BASE_URL, GO_BASE_URL, 'goMode is the default mode');

  const ctx = { get: () => undefined };
  assert.equal(resolveOptions(ctx, {}).baseURL, GO_BASE_URL, 'default');
  assert.equal(resolveOptions(ctx, { goMode: true }).baseURL, GO_BASE_URL);
  assert.equal(resolveOptions(ctx, { goMode: false }).baseURL, ZEN_BASE_URL, 'metered mode');
  assert.equal(
    resolveOptions(ctx, { goMode: false, baseURL: 'https://self.hosted/v1' }).baseURL,
    'https://self.hosted/v1',
    'an explicit endpoint overrides the mode',
  );
  assert.equal(
    resolveOptions(ctx, { goMode: false, baseURL: '' }).baseURL,
    ZEN_BASE_URL,
    'a blank endpoint falls back to the mode',
  );
});

test('search() posts to the metered endpoint when goMode is off', async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(url);
    return new Response(JSON.stringify(liveLikeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () =>
      resolveOptions(ctx, { apiKey: 'sk-test', goMode: false }));
    await provider.search({ query: 'anything' });
    assert.deepEqual(seen, ['https://opencode.ai/zen/v1/messages']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a 402 names the metered endpoint and points back at goMode', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Insufficient account funds' } }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () =>
      resolveOptions(ctx, { apiKey: 'sk-test', goMode: false, retries: 0 }));
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      (error) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.match(error.message, /402/u);
        assert.match(error.message, /zen\/v1/u);
        assert.match(error.message, /goMode/u);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ── the override-official switch ─────────────────────────────────────────────

/** A ctx whose `web` registry holds a stub `deepseek-official` provider. */
function ctxWithOfficial(official) {
  const web = {
    registerSearchProvider: () => () => {},
    searchProviders: new Map(official === undefined ? [] : [[OFFICIAL_PROVIDER_ID, official]]),
  };
  return { get: (key) => (key === 'web' ? web : undefined), web };
}

test('overrideOfficial defaults on, so this plugin is authoritative', () => {
  const ctx = { get: () => undefined };
  assert.equal(resolveOptions(ctx, {}).overrideOfficial, true);
  assert.equal(resolveOptions(ctx, { overrideOfficial: false }).overrideOfficial, false);
});

test('overrideOfficial off delegates the search to the official provider', async () => {
  const calls = [];
  const official = {
    id: OFFICIAL_PROVIDER_ID,
    available: () => true,
    search: async (request) => {
      calls.push(request);
      return { sources: [{ url: 'https://official.example/1', title: 'Official' }], truncated: false };
    },
  };
  const ctx = ctxWithOfficial(official);
  // No credential anywhere: the OpenCode path would throw, so a clean result
  // proves the request never went down it.
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false }));
  const result = await provider.search({ query: 'delegated' });
  assert.deepEqual(calls, [{ query: 'delegated' }]);
  assert.equal(result.sources[0].url, 'https://official.example/1');
});

test('overrideOfficial off forwards the abort signal to the official provider', async () => {
  let seen;
  const official = {
    id: OFFICIAL_PROVIDER_ID,
    available: () => true,
    search: async (_request, signal) => {
      seen = signal;
      return { sources: [], truncated: false };
    },
  };
  const ctx = ctxWithOfficial(official);
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false }));
  const controller = new AbortController();
  await provider.search({ query: 'x' }, controller.signal);
  assert.equal(seen, controller.signal);
});

test('overrideOfficial off without the official provider explains itself', async () => {
  const ctx = ctxWithOfficial(undefined);
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false }));
  assert.equal(provider.available(), false);
  await assert.rejects(
    () => provider.search({ query: 'x' }),
    (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.match(error.message, /deepseek-official/u);
      assert.match(error.message, /not registered/u);
      return true;
    },
  );
});

test('overrideOfficial off mirrors the official provider availability', () => {
  const ctx = ctxWithOfficial({ id: OFFICIAL_PROVIDER_ID, available: () => false, search: async () => ({}) });
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false, apiKey: 'sk-ignored' }));
  assert.equal(provider.available(), false, 'a local key does not make pass-through usable');
});

// ── credential references ────────────────────────────────────────────────────
// Renaming the plugin must not lock existing installs out of search: a key
// stored under the pre-rename reference has to keep resolving.

test('credentialRefs tries the configured reference first, then both spellings', () => {
  assert.deepEqual(credentialRefs({ apiKeyEnv: 'CUSTOM_KEY' }), [
    'CUSTOM_KEY',
    DEFAULT_API_KEY_ENV,
    FALLBACK_API_KEY_ENV,
  ]);
  assert.deepEqual(credentialRefs({}), [DEFAULT_API_KEY_ENV, FALLBACK_API_KEY_ENV]);
  assert.deepEqual(credentialRefs({ apiKeyEnv: '' }), [DEFAULT_API_KEY_ENV, FALLBACK_API_KEY_ENV]);
  assert.deepEqual(
    credentialRefs({ apiKeyEnv: FALLBACK_API_KEY_ENV }),
    [FALLBACK_API_KEY_ENV, DEFAULT_API_KEY_ENV],
    'no duplicate when the configured reference is already canonical',
  );
  assert.equal(DEFAULT_API_KEY_ENV, 'OPENCODE_API_KEY');
  assert.equal(FALLBACK_API_KEY_ENV, 'OPENCODE_GO_API_KEY');
});

test('search() resolves a key stored under the pre-rename reference', async () => {
  const asked = [];
  const ctx = {
    get: (key) =>
      key === 'credentials'
        ? {
            resolve: async (ref) => {
              asked.push(ref);
              return ref === FALLBACK_API_KEY_ENV ? { value: 'sk-legacy' } : undefined;
            },
          }
        : undefined,
  };
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = init.headers['x-api-key'];
    return new Response(JSON.stringify(liveLikeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, {}));
    assert.equal(provider.available(), true);
    await provider.search({ query: 'legacy key' });
    assert.deepEqual(asked, [DEFAULT_API_KEY_ENV, FALLBACK_API_KEY_ENV]);
    assert.equal(sent, 'sk-legacy');
  } finally {
    globalThis.fetch = original;
  }
});

// ── the settings schema ──────────────────────────────────────────────────────
// A field is editable from the Plugins page only while it is volatile, and the
// form is served only while the row declares a Config at all.

test('Config publishes both switches as volatile booleans', () => {
  const field = (name) => Config.dict[name];
  assert.equal(field('overrideOfficial').type, 'boolean');
  assert.equal(field('overrideOfficial').meta.volatile, true);
  assert.equal(field('overrideOfficial').meta.default, true);
  assert.equal(field('goMode').type, 'boolean');
  assert.equal(field('goMode').meta.volatile, true);
  assert.equal(field('goMode').meta.default, true);

  assert.equal(field('baseURL').meta.volatile, true);
  assert.equal(field('maxUses').meta.volatile, true);
  assert.equal(field('apiKey').meta.role, 'secret');
  assert.equal(field('apiKeyEnv').meta.role, 'credential-ref');
  assert.equal(field('apiKeyEnv').meta.default, DEFAULT_API_KEY_ENV);

  // Load-time-only knobs stay non-volatile so they never appear in the form.
  for (const name of ['retries', 'sessionMode', 'queryTemplate']) {
    assert.notEqual(field(name).meta.volatile, true, `${name} should stay load-time config`);
  }
  // The schema must name every key the bundle patch sets, because a patch
  // replaces the whole config of its row rather than merging.
  assert.deepEqual(Object.keys(Config.dict).sort(), [
    'apiKey', 'apiKeyEnv', 'apiVersion', 'baseURL', 'goMode', 'includeAnswer',
    'maxTokens', 'maxUses', 'model', 'overrideOfficial', 'queryTemplate',
    'retries', 'sessionMode', 'timeoutMs',
  ]);
});

test('Config accepts an empty config and applies every default', () => {
  const ctx = { get: () => undefined };
  const options = resolveOptions(ctx, new Config({}));
  assert.equal(options.baseURL, GO_BASE_URL);
  assert.equal(options.model, DEFAULT_MODEL);
  assert.equal(options.maxUses, DEFAULT_MAX_USES);
  assert.equal(options.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(options.retries, DEFAULT_RETRIES);
  assert.equal(options.goMode, true);
  assert.equal(options.overrideOfficial, true);
});
