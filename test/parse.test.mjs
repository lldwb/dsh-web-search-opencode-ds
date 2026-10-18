// dsh-web-search-opencode-ds 的解析器与选项测试。
//
// 运行方式：node --test test/
//
// 响应 fixture 对照的是 2026-10-02 从
// POST https://opencode.ai/zen/go/v1/messages 拿到的真实响应：
// `web_search_result` 项带有 title/url/page_age 和一个不透明的
// `encrypted_content`，没有内联摘要。

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

/** 一个与线上响应形态一致的最小成功响应体。 */
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
          // 重复的 URL：必须被去重。
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

test('buildSearchBody 会发送原生 web_search 服务端工具', () => {
  const body = buildSearchBody(
    { model: 'deepseek-v4-flash', maxTokens: 4096, maxUses: 5, queryTemplate: 'Perform a web search for the query: {query}' },
    'who won',
  );
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.tools, [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  ]);
  // content 是块数组，绝不是裸字符串。
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Perform a web search for the query: who won' },
  ]);
});

test('模板中没有占位符时 buildSearchBody 会追加查询词', () => {
  const body = buildSearchBody(
    { model: 'm', maxTokens: 1, maxUses: 1, queryTemplate: 'Search: ' },
    'x',
  );
  assert.equal(body.messages[0].content[0].text, 'Search: x');
});

test('mapAnthropicResponse 提取 title/url/publishedAt 并按 url 去重', () => {
  const result = mapAnthropicResponse(liveLikeResponse());
  assert.equal(result.truncated, false);
  assert.equal(result.content, undefined, '默认不暴露散文式内容');
  assert.equal(result.sources.length, 2, '重复的 url 被丢弃');
  assert.deepEqual(result.sources[0], { url: 'https://example.com/a', title: 'DeepSeek V4 released' });
  assert.deepEqual(result.sources[1], {
    url: 'https://example.com/b',
    title: 'DeepSeek returns with V4-Pro and V4-Flash',
    publishedAt: '2026-04-24',
  });
  // 不透明的数据块绝不能泄漏到来源列表里。
  assert.equal(JSON.stringify(result.sources).includes('opaque-blob'), false);
});

test('部署不输出引用时 mapAnthropicResponse 省略 snippet', () => {
  const result = mapAnthropicResponse(liveLikeResponse());
  for (const source of result.sources) {
    assert.equal('snippet' in source, false, '不会凭空编造 snippet');
  }
});

test('存在 cited_text 时 mapAnthropicResponse 会把它接为 snippet', () => {
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

test('citationSnippets 对每个 url 保留首次出现的值', () => {
  const map = citationSnippets([
    { type: 'text', citations: [{ url: 'u', cited_text: 'first' }] },
    { type: 'text', citations: [{ url: 'u', cited_text: 'second' }] },
    { type: 'text', citations: [{ url: 'v' }] },
  ]);
  assert.equal(map.get('u'), 'first');
  assert.equal(map.has('v'), false, '没有 cited_text 的引用不贡献任何内容');
});

test('mapAnthropicResponse 仅在要求时才暴露回答', () => {
  const result = mapAnthropicResponse(liveLikeResponse(), { includeAnswer: true });
  assert.equal(result.content, 'DeepSeek V4 Flash shipped on April 24, 2026.');
});

test('没有结果块时 mapAnthropicResponse 抛 WEB_PROVIDER_ERROR', () => {
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

test('mapAnthropicResponse 能容忍畸形响应体', () => {
  assert.throws(() => mapAnthropicResponse(undefined), WebSearchError);
  assert.throws(() => mapAnthropicResponse({ content: 'nope' }), WebSearchError);
});

test('resolveOptions 会应用每一个已文档化的默认值', () => {
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

test('resolveOptions 能读取普通配置对象', () => {
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

test('resolveOptions 会解开 schemastery 风格的 volatile 引用', () => {
  const options = resolveOptions({ get: () => undefined }, {
    baseURL: { get: () => 'https://from-ref.test/v1' },
    model: { get: () => 'ref-model' },
  });
  assert.equal(options.baseURL, 'https://from-ref.test/v1');
  assert.equal(options.model, 'ref-model');
});

test('提供方 id 与文档一致', () => {
  const provider = new OpenCodeSearchProvider({ get: () => undefined }, () => resolveOptions({ get: () => undefined }, undefined));
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(PROVIDER_ID, 'opencode-ds');
});

test('没有任何凭据时 available() 为 false，有环境变量时为 true', () => {
  const ctx = { get: () => undefined };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, undefined));

  const saved = process.env[DEFAULT_API_KEY_ENV];
  delete process.env[DEFAULT_API_KEY_ENV];
  delete process.env.OPENCODE_API_KEY;
  try {
    assert.equal(provider.available(), false, '没有密钥，也没有凭据服务');
    process.env[DEFAULT_API_KEY_ENV] = 'sk-test';
    assert.equal(provider.available(), true);
  } finally {
    if (saved === undefined) delete process.env[DEFAULT_API_KEY_ENV];
    else process.env[DEFAULT_API_KEY_ENV] = saved;
  }
});

test('挂载了凭据服务时 available() 取乐观态度', () => {
  const ctx = { get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined) };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, undefined));
  const saved = process.env[DEFAULT_API_KEY_ENV];
  delete process.env[DEFAULT_API_KEY_ENV];
  delete process.env.OPENCODE_API_KEY;
  try {
    assert.equal(provider.available(), true, '解析推迟到搜索时进行');
  } finally {
    if (saved !== undefined) process.env[DEFAULT_API_KEY_ENV] = saved;
  }
});

test('available() 会拒绝无法解析的 baseURL 和非正数上限', () => {
  const ctx = { get: () => undefined };
  const make = (config) => new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, config));
  assert.equal(make({ baseURL: 'not a url', apiKey: 'k' }).available(), false);
  assert.equal(make({ maxTokens: 0, apiKey: 'k' }).available(), false);
  assert.equal(make({ maxUses: -1, apiKey: 'k' }).available(), false);
  assert.equal(make({ model: '', apiKey: 'k' }).available(), false);
  assert.equal(make({ apiKey: 'k' }).available(), true);
});

test('search() 用稳定错误码报告凭据缺失', async () => {
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

test('search() 优先从凭据服务解析密钥', async () => {
  const ctx = {
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'sk-from-store' }) } : undefined),
  };
  const provider = new OpenCodeSearchProvider(ctx, () => resolveOptions(ctx, { baseURL: 'https://example.test/v1' }));
  assert.equal(await provider.resolveApiKey(resolveOptions(ctx, {}), undefined), 'sk-from-store');
});

test('凭据库中没有值时 search() 回退到环境变量', async () => {
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

test('search() 会遵从已经中止的信号', async () => {
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

test('search() 会发送两个鉴权头、一个会话 id 和工具块', async () => {
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

    assert.equal(calls.length, 1, '成功时只尝试一次');
    assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/messages');
    const headers = calls[0].init.headers;
    assert.equal(headers['x-api-key'], 'sk-test', '由 x-api-key 完成鉴权');
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['x-opencode-client'], 'dsh');
    assert.match(headers['user-agent'], /^dsh-web-search-opencode-ds\//);
    assert.match(
      headers['x-opencode-session'],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      '每次请求都会生成一个 UUID v4 会话 id',
    );
    assert.equal(calls[0].init.redirect, 'error');

    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
    assert.equal(result.sources.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('默认情况下 search() 每次请求都新生成会话 id', async () => {
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
    assert.notEqual(sessions[0], sessions[1], 'per-request 模式不复用 id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stable 模式下 search() 复用同一个会话 id', async () => {
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
    assert.equal(sessions[0], sessions[1], 'stable 模式保持提示词缓存亲和性');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('遇到可重试状态码时 search() 重试一次后成功', async () => {
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
    assert.equal(attempts, 2, '首次尝试后重试一次');
    assert.equal(result.sources.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search() 不会重试鉴权失败', async () => {
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
        // 提示会指出实际被计费的那个模式，因此 Go 模式下的 401 指向订阅，
        // 按量计费模式下的 401 指向 API 密钥。
        assert.match(error.message, /OpenCode Go 套餐/u);
        assert.match(error.message, /goMode/u);
        return true;
      },
    );
    assert.equal(attempts, 1, '坏密钥不会被重试');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('遇到 MissingSessionID 时 search() 重试一次并解释该请求头', async () => {
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
    assert.equal(attempts, 2, 'MissingSessionID 会得到一次重试');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('apply() 会把提供方注册到 web seam', () => {
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

// ── 身份标识 ─────────────────────────────────────────────────────────────────
// 插件是按它是什么（OpenCode + DeepSeek）命名的，而不是按它恰好计费的那份套餐。
// 「Go」只是一个开关，因此不能出现在任何身份标识里：loader 名称、提供方 id、设置
// 命名空间、归属标识请求头。设置命名空间尤其必须等于 Loader 行 id，否则浏览器表单
// 会挂载到一个没人提供的命名空间上。

test('身份标识中不含套餐名', () => {
  assert.equal(name, 'web-search-opencode-ds');
  assert.equal(PROVIDER_ID, 'opencode-ds');
  assert.equal(SETTINGS_NAMESPACE, name);
  assert.equal(OFFICIAL_PROVIDER_ID, 'deepseek-official');
  for (const value of [name, PROVIDER_ID, SETTINGS_NAMESPACE, USER_AGENT]) {
    assert.doesNotMatch(value, /go/iu, `${value} 不得出现 Go 套餐名`);
  }
});

// ── Go / 按量计费开关 ────────────────────────────────────────────────────────

test('goMode 决定端点，而显式 baseURL 仍然优先', () => {
  assert.equal(GO_BASE_URL, 'https://opencode.ai/zen/go/v1');
  assert.equal(ZEN_BASE_URL, 'https://opencode.ai/zen/v1');
  assert.equal(DEFAULT_BASE_URL, GO_BASE_URL, 'goMode 是默认模式');

  const ctx = { get: () => undefined };
  assert.equal(resolveOptions(ctx, {}).baseURL, GO_BASE_URL, '默认');
  assert.equal(resolveOptions(ctx, { goMode: true }).baseURL, GO_BASE_URL);
  assert.equal(resolveOptions(ctx, { goMode: false }).baseURL, ZEN_BASE_URL, '按量计费模式');
  assert.equal(
    resolveOptions(ctx, { goMode: false, baseURL: 'https://self.hosted/v1' }).baseURL,
    'https://self.hosted/v1',
    '显式端点会覆盖模式设置',
  );
  assert.equal(
    resolveOptions(ctx, { goMode: false, baseURL: '' }).baseURL,
    ZEN_BASE_URL,
    '端点留空时回退到模式决定的值',
  );
});

test('goMode 关闭时 search() 发往按量计费端点', async () => {
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

test('402 会指明按量计费端点并指回 goMode', async () => {
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

// ── 覆盖官方配置的开关 ───────────────────────────────────────────────────────

/** 一个 `web` 注册表里放着 `deepseek-official` 桩提供方的 ctx。 */
function ctxWithOfficial(official) {
  const web = {
    registerSearchProvider: () => () => {},
    searchProviders: new Map(official === undefined ? [] : [[OFFICIAL_PROVIDER_ID, official]]),
  };
  return { get: (key) => (key === 'web' ? web : undefined), web };
}

test('overrideOfficial 默认开启，因此本插件是权威', () => {
  const ctx = { get: () => undefined };
  assert.equal(resolveOptions(ctx, {}).overrideOfficial, true);
  assert.equal(resolveOptions(ctx, { overrideOfficial: false }).overrideOfficial, false);
});

test('overrideOfficial 关闭时把搜索委托给官方提供方', async () => {
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
  // 哪里都没有凭据：OpenCode 这条路径会抛错，因此能干净地返回结果就证明
  // 该请求从未走这条路。
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false }));
  const result = await provider.search({ query: 'delegated' });
  assert.deepEqual(calls, [{ query: 'delegated' }]);
  assert.equal(result.sources[0].url, 'https://official.example/1');
});

test('overrideOfficial 关闭时把中止信号转发给官方提供方', async () => {
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

test('overrideOfficial 关闭且没有官方提供方时会给出解释', async () => {
  const ctx = ctxWithOfficial(undefined);
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false }));
  assert.equal(provider.available(), false);
  await assert.rejects(
    () => provider.search({ query: 'x' }),
    (error) => {
      assert.ok(error instanceof WebSearchError);
      assert.match(error.message, /deepseek-official/u);
      assert.match(error.message, /未注册/u);
      return true;
    },
  );
});

test('overrideOfficial 关闭时可用性跟随官方提供方', () => {
  const ctx = ctxWithOfficial({ id: OFFICIAL_PROVIDER_ID, available: () => false, search: async () => ({}) });
  const provider = new OpenCodeSearchProvider(ctx, () =>
    resolveOptions(ctx, { overrideOfficial: false, apiKey: 'sk-ignored' }));
  assert.equal(provider.available(), false, '本地密钥并不能让直通模式变得可用');
});

// ── 凭据引用 ─────────────────────────────────────────────────────────────────
// 重命名插件不能把既有安装挡在搜索之外：存放在改名之前那个引用下的密钥必须继续
// 能解析到。

test('credentialRefs 先试配置的引用，再试两种写法', () => {
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
    '配置的引用已是规范写法时不会重复',
  );
  assert.equal(DEFAULT_API_KEY_ENV, 'OPENCODE_API_KEY');
  assert.equal(FALLBACK_API_KEY_ENV, 'OPENCODE_GO_API_KEY');
});

test('search() 能解析存放在改名之前引用下的密钥', async () => {
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

// ── 设置 schema ──────────────────────────────────────────────────────────────
// 只有当字段是 volatile 时才能从插件页编辑，而只有当该行声明了 Config 时表单才会
// 被提供出来。

test('Config 把两个开关都发布为 volatile 布尔字段', () => {
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

  // 仅在加载期生效的旋钮保持非 volatile，因此永远不会出现在表单里。
  for (const name of ['retries', 'sessionMode', 'queryTemplate']) {
    assert.notEqual(field(name).meta.volatile, true, `${name} 应保持为加载期配置`);
  }
  // schema 必须列出 bundle 补丁设置的每一个键，因为补丁是整体替换其所在行的 config，
  // 而不是做合并。
  assert.deepEqual(Object.keys(Config.dict).sort(), [
    'apiKey', 'apiKeyEnv', 'apiVersion', 'baseURL', 'goMode', 'includeAnswer',
    'maxTokens', 'maxUses', 'model', 'overrideOfficial', 'queryTemplate',
    'retries', 'sessionMode', 'timeoutMs',
  ]);
});

test('Config 接受空配置并应用每一个默认值', () => {
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

// ── 模型换代 ────────────────────────────────────────────────────────────────
// 2026-10-18 实测：Go 套餐下架了 `deepseek-v4-flash`，只剩 `deepseek-v4.1-flash`
// 与 `deepseek-v4-pro`；按量计费侧仍保留旧的。默认值必须在两条路由都能跑，
// 否则切一下 goMode 就静默失效。

test('默认模型在两条路由上都存在', () => {
  assert.equal(DEFAULT_MODEL, 'deepseek-v4.1-flash');
  // 回归保护：这是当初真正踩到的坑——Go 下架 v4-flash 让旧默认值直接失效。
  assert.notEqual(DEFAULT_MODEL, 'deepseek-v4-flash');
});

test('端点不认这个模型时给出可执行的排查提示', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'model: unknown model deepseek-v4-flash' },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  try {
    const ctx = { get: () => undefined };
    const provider = new OpenCodeSearchProvider(ctx, () =>
      resolveOptions(ctx, { apiKey: 'sk-test', model: 'deepseek-v4-flash', retries: 0 }));
    await assert.rejects(
      () => provider.search({ query: 'x' }),
      (error) => {
        assert.ok(error instanceof WebSearchError);
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        // 消息必须点名当前模型、当前端点，并给出 /models 这条可执行的动作。
        assert.match(error.message, /deepseek-v4-flash/u);
        assert.match(error.message, /\/models/u);
        // 还要解释为什么换模式可能有用（两条路由目录不同）。
        assert.match(error.message, /路由|goMode/u);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

