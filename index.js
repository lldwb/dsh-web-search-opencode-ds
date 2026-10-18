/**
 * `dsh-web-search-opencode-ds` —— 一个 DSH `WebSearchProvider`（id 为
 * `opencode-ds`），通过 OpenCode 的 Anthropic 兼容 Messages 接口运行 DeepSeek
 * 官方的服务端网页搜索。`goMode` 决定用哪一份 OpenCode 套餐：包月的 Go 订阅
 * （`/zen/go/v1`，默认值）还是默认的按量计费 API（`/zen/v1`）。
 *
 * ## 针对线上端点实测确认过的事实
 *
 * ### 2026-10-02（初次验证）
 *
 * | 观察项 | 结果 |
 * |---|---|
 * | `POST https://opencode.ai/zen/go/v1/messages`，`model: deepseek-v4-flash`，工具 `web_search_20250305` | **HTTP 200**，返回真实的 `web_search_tool_result` 块 |
 * | 同样的请求**不带** `x-opencode-session` | **HTTP 400** `{"type":"error","error":{"type":"MissingSessionID",...}}` |
 * | **只**发 `Authorization: Bearer <key>`（不带 `x-api-key`） | **HTTP 401** `AuthError: Missing API key.` |
 * | 只发 `x-api-key: <key>` | **HTTP 200** |
 * | `GET /zen/go/v1/models` | 200；`deepseek-v4-flash` 在 id 列表中 |
 * | 候选的会话创建路径（`/sessions`、`/session` 等） | 全部 **404** —— 不存在会话创建端点 |
 *
 * ### 2026-10-18（复验）
 *
 * | 观察项 | 结果 |
 * |---|---|
 * | `GET /zen/go/v1/models` | 200，**37** 个模型（上次 43）；deepseek 只剩 `deepseek-v4.1-flash`、`deepseek-v4-pro` |
 * | `GET /zen/v1/models` | 200，**85** 个模型；含 `deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-free`、`deepseek-v4-pro` |
 * | **`deepseek-v4-flash` 是否还在 Go 套餐里** | **不在了**。Go 已下架该模型，按量计费侧仍保留 |
 * | 专用检索 API（`/search`、`/fetch`、`/tools/search`、`/tools/fetch`、`/web/search`、`/web/fetch`，两条路由 GET+POST） | 全部 **404** —— OpenCode **没有** DeepSeek 那套专用 Search/Fetch API |
 * | `v2` 路由家族（`/zen/go/v2/models`、`/zen/v2/models`） | **404** —— 没有版本跃迁 |
 * | 已存储的 key | **已过期**：`authentication_error: This API key has expired.` |
 *
 * **因此 2026-10-18 这一轮无法复验**「`web_search_20250305` 是否仍是当前工具版本」
 * 以及「Go 套餐是否支持更新版 API」—— 两条都需要有效凭据。这里不臆测结论；
 * 已知的确定性事实是：OpenCode 只有 Messages 一条检索路径，专用 API 不存在。
 *
 * 由此固化进本实现的结论：
 *
 * 1. **`x-opencode-session` 是必需的**，且由*客户端生成*。提供方默认每次搜索
 *    都发一个新的 UUID v4（`sessionMode: 'per-request'`）；`'stable'` 则所有
 *    搜索复用同一个 id。这里既没有注册调用，响应里也没有携带会话 id 的字段，
 *    所以「先创建会话」这条分支并不存在。
 * 2. **真正完成鉴权的是 `x-api-key` 这个请求头。** 任务说明只要求发
 *    `Authorization: Bearer`；只发它会得到 401。因此两个头都会发送，好让提供方
 *    在两种网关行为下都能存活。
 * 3. `web_search_result` 项带有 `title`、`url` 和 `page_age`（外加一个不透明的
 *    `encrypted_content`），但**没有内联摘要**。因此当某个部署会输出
 *    `citations[].cited_text` 时，就由它拼出摘要；否则直接省略，而不是凭空编造。
 *
 * ## 设置页
 *
 * 插件声明了一个 `Config` schema，其中可编辑字段都带 `.volatile()` —— 这正是
 * 它们能出现在「设置 → 插件 → 本插件」里、并且热改后依然生效的原因。
 * `client.js`（浏览器半，通过 package.json 里的 `dsh.client` 声明）负责绘制表单。
 *
 * ## `@deepseek-ai/*` 导入
 *
 * DSH 自身的包无法从 DSH profile 目录解析，因此装在 profile 里的插件不能
 * `import '@deepseek-ai/dsh-web'`。所以本包只导入 `@deepseek-ai/schemastery`：
 * 它是一个公开的 npm 包（MIT），装在本包自己的 `node_modules` 里 —— 也是 Node
 * 相对本文件唯一能解析到的那个导入。
 *
 * @module dsh-web-search-opencode-ds
 */

import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

/** Cordis 插件名，用于 loader 诊断，同时也作为设置命名空间。 */
export const name = 'web-search-opencode-ds';

/** 本提供方注册进的那个 web seam。 */
export const inject = ['web'];

/** 本插件注册时使用的稳定提供方 id。 */
export const PROVIDER_ID = 'opencode-ds';

/** 本插件表单所编辑的设置命名空间（是 Loader 行 id，不是包名）。 */
export const SETTINGS_NAMESPACE = name;

/** 内置提供方；当 `overrideOfficial` 关闭时可以委托给它。 */
export const OFFICIAL_PROVIDER_ID = 'deepseek-official';

/**
 * OpenCode Go 基址：包月订阅套餐。使用时会在后面拼上 `/messages`。
 * 这也是模式开关出现之前提供方一直使用的端点。
 */
export const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * OpenCode Zen 基址：默认的按量计费（用多少付多少）API。两条路由的模型目录不同：
 * 2026-10-18 实测 `/zen/v1/models` 有 85 个 id，而 `/zen/go/v1/models` 只有 37 个；
 * `deepseek-v4-flash` 只在按量计费侧存在，Go 套餐已下架它。请求打到这里的费用从
 * 账户余额扣除而不是走 Go 套餐，因此在账户充值之前会返回 HTTP 402
 * 「Insufficient account funds」—— 这是配置事实，不是本插件的 bug。
 */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

/** 向后兼容别名：`goMode` 开启时使用的基址。 */
export const DEFAULT_BASE_URL = GO_BASE_URL;

/**
 * 默认的 Anthropic 格式模型 id。
 *
 * 选 `deepseek-v4.1-flash` 而不是旧的 `deepseek-v4-flash`：2026-10-18 实测前者在
 * **两条路由都存在**，后者已从 Go 套餐下架（只剩按量计费侧）。默认值必须在两种
 * 模式下都能跑，否则切一下 `goMode` 就会静默失效。
 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';

/** 默认的 `anthropic-version` 请求头取值。 */
export const DEFAULT_API_VERSION = '2023-06-01';

/** Messages 请求生成 token 数的默认上限。 */
export const DEFAULT_MAX_TOKENS = 4096;

/** 单次请求中 `web_search` 服务端工具默认最多可使用几次。 */
export const DEFAULT_MAX_USES = 5;

/** 每次尝试的默认超时时间。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 首次尝试之后的默认重试次数（即总共 2 次尝试）。 */
export const DEFAULT_RETRIES = 1;

/** 首选凭据引用。 */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY';

/** 次级凭据引用，保留它是为了让已有的 OpenCode Go 密钥仍能解析到。 */
export const FALLBACK_API_KEY_ENV = 'OPENCODE_GO_API_KEY';

/** 每次请求都会发送的归属标识请求头。 */
export const USER_AGENT = 'dsh-web-search-opencode-ds/0.3.0';

/** 提示词模板；`{query}` 会被替换为调用方的查询词。 */
export const DEFAULT_QUERY_TEMPLATE = 'Perform a web search for the query: {query}';

/** 默认的会话 id 策略：每次搜索都新生成一个 UUID v4。 */
export const DEFAULT_SESSION_MODE = 'per-request';

/** `goMode` 的默认值：开启，即计入 OpenCode Go 套餐。 */
export const DEFAULT_GO_MODE = true;

/** `overrideOfficial` 的默认值：开启，即由本插件而非内置提供方作答。 */
export const DEFAULT_OVERRIDE_OFFICIAL = true;

/**
 * 该行的 Config schema。
 *
 * `.volatile()` 正是把字段发布到设置表单的机制：DSH 会把生效 profile 条目中的
 * volatile 字段投影到一个表单命名空间，设置服务则通过 profile 的 Cordis 补丁
 * 持久化改动。非 volatile 的字段仍是加载期配置，只能在 `cordis.patch.yml` 里改。
 *
 * schema 必须列出 bundle 补丁设置的每一个键 —— 补丁会**整体替换**目标行的
 * `config`，因此这里缺失的键要么被丢弃，要么在加载时被拒绝。
 */
export const Config = z.object({
  /** 字面密钥。优先于凭据引用；表单从不持久化它。 */
  apiKey: z.string().role('secret').volatile(),
  /** 凭据引用，先经 `ctx.credentials` 解析，再回退到环境变量。 */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  /** 显式指定的端点基址。留空表示「由 `goMode` 推导」。 */
  baseURL: z.string().volatile(),
  /** Anthropic 格式的模型 id。 */
  model: z.string().default(DEFAULT_MODEL).volatile(),
  /** `anthropic-version` 请求头取值。 */
  apiVersion: z.string().default(DEFAULT_API_VERSION).volatile(),
  /** 生成 token 数的上限。 */
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  /** 单次请求中服务端搜索次数的上限。 */
  maxUses: z.number().step(1).min(1).default(DEFAULT_MAX_USES).volatile(),
  /** 每次尝试的超时时间。 */
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS).volatile(),
  /** 首次尝试之后的重试次数。 */
  retries: z.number().step(1).min(0).default(DEFAULT_RETRIES),
  /** 会话 id 策略。 */
  sessionMode: z.union(['per-request', 'stable']).default(DEFAULT_SESSION_MODE),
  /** 提示词模板；会替换其中的 `{query}`。 */
  queryTemplate: z.string().default(DEFAULT_QUERY_TEMPLATE),
  /** 是否把模型的散文式回答作为结果的 `content` 暴露出去。 */
  includeAnswer: z.boolean().default(false).volatile(),
  /**
   * `true`（默认）：使用这里配置的 OpenCode 端点 —— 本插件覆盖内置提供方的配置。
   * `false`：把每次搜索原样委托给 `deepseek-official`，让官方提供方自己的配置
   * 继续生效。
   */
  overrideOfficial: z.boolean().default(DEFAULT_OVERRIDE_OFFICIAL).volatile(),
  /**
   * `true`（默认）：走 OpenCode Go 包月套餐端点（`/zen/go/v1`）。
   * `false`：走默认的按量计费 API（`/zen/v1`），按次计费。
   */
  goMode: z.boolean().default(DEFAULT_GO_MODE).volatile(),
});

/** 值得再试一次的 HTTP 状态码。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 携带 seam 错误词汇表的稳定、可机器路由的错误。 */
export class WebSearchError extends Error {
  /**
   * @param {string} message - 供人阅读的详细信息。
   * @param {string} code - 稳定错误码，例如 `WEB_PROVIDER_CREDENTIAL_MISSING`。
   * @param {{ cause?: unknown, retryable?: boolean }} [options] - 原因与重试提示。
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WebSearchError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

/**
 * 读取一个配置值，同时兼容普通值和 schemastery 的「volatile」引用（后者暴露
 * `.get()`），这样无论该行是否被 Config schema 包装过，本插件的行为都一致。
 *
 * @param {unknown} config - 传给 `apply` 的行配置。
 * @param {string} key - 字段名。
 * @param {unknown} fallback - 字段缺失或为 null 时使用的值。
 * @returns {unknown} 解析出的值。
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

/** 为正整数时返回 true。 */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** 为非负整数时返回 true。 */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** 当 `value` 能解析为绝对 URL 时返回 true。 */
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

/** 读取一个非空环境变量，取不到则返回 undefined。 */
function envValue(key) {
  if (typeof key !== 'string' || key.length === 0) return undefined;
  const value = process.env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 构建用于挂接摘要的 `url → cited_text` 映射。 */
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

/** 候选值中第一个非空字符串。 */
function firstNonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** 拼接所有 `text` 块；没有散文式内容时返回 undefined。 */
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
 * 为一次搜索构建 Anthropic Messages 请求体。
 *
 * `content` 以块数组而不是裸字符串发送：两种形式对 DeepSeek 的 Anthropic 兼容
 * 接口都能用，但数组形式是官方文档化的写法，也能避开 `Empty input messages`
 * 那一类 400。
 *
 * @param {{ model: string, maxTokens: number, maxUses: number, queryTemplate: string }} options - 已解析的选项。
 * @param {string} query - 调用方的查询词。
 * @returns {object} JSON 请求体。
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
 * 把 DeepSeek/Anthropic 的 Messages 响应映射为 seam 的搜索结果。
 *
 * 遍历 `web_search_tool_result` 块以取出 `web_search_result` 项，在存在引用摘录时
 * 为每一项接上对应摘录，并按 URL 去重（`max_uses > 1` 的请求可能在不同搜索中命中
 * 同一个 URL）。最终的 `maxResults` 截断由 web seam 负责，所以这里的 `truncated`
 * 恒为 `false`。
 *
 * @param {object} response - 解析后的 Messages 响应体。
 * @param {{ includeAnswer?: boolean }} [options] - 是否把模型的散文式内容作为 `content` 暴露出去。
 * @returns {{ content?: string, sources: object[], truncated: boolean }} 归一化后的结果。
 * @throws {WebSearchError} 响应中不含结果块时抛 `WEB_PROVIDER_ERROR`。
 */
export function mapAnthropicResponse(response, options = {}) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new WebSearchError(
      'OpenCode 没有返回任何 web_search_tool_result 块；该请求可能没有触发原生网页搜索。' +
        '请检查所配置的模型是否支持 web_search_20250305 服务端工具。',
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

/** 调用方已经中止时，抛出本提供方的稳定取消错误。 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw new WebSearchError('OpenCode 网页搜索已中止', 'WEB_ABORTED', {
      cause: signal.reason,
    });
  }
}

/**
 * 让单次尝试的超时与调用方的取消相互竞争，同时不依赖 `AbortSignal.any`
 * （这样插件在较老的宿主上也能运行）。
 *
 * @param {AbortSignal | undefined} callerSignal - 调用方的信号。
 * @param {number} timeoutMs - 每次尝试的时间预算。
 * @returns {{ signal: AbortSignal, didTimeout: () => boolean, cleanup: () => void }} 本次尝试的信号。
 */
function createAttemptSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`OpenCode 网页搜索在 ${timeoutMs}ms 后超时`));
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

/** 两次尝试之间可被中止的延时。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new WebSearchError('OpenCode 网页搜索已中止', 'WEB_ABORTED', { cause: signal.reason }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new WebSearchError('OpenCode 网页搜索已中止', 'WEB_ABORTED', { cause: signal?.reason }));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** 从 Anthropic 风格的错误体里提取最有用的那条信息。 */
function errorDetail(parsed) {
  const error = parsed?.error;
  if (typeof error === 'string' && error.length > 0) return error;
  if (typeof error?.message === 'string' && error.message.length > 0) return error.message;
  if (typeof parsed?.message === 'string' && parsed.message.length > 0) return parsed.message;
  return undefined;
}

/** 当非 2xx 响应体指出「缺少会话」这一情况时返回 true。 */
function isMissingSession(parsed) {
  const type = parsed?.error?.type;
  if (typeof type === 'string' && /MissingSessionID/i.test(type)) return true;
  return /MissingSessionID/i.test(JSON.stringify(parsed ?? ''));
}

/**
 * OpenCode 搜索提供方。
 *
 * 选项按操作重新解析（用 thunk 而不是快照），这样配置变更无需重新注册提供方就能
 * 作用到下一次搜索 —— 重新注册会让 seam 的选择过程表现为一次闪烁。
 */
export class OpenCodeSearchProvider {
  /**
   * @param {object} ctx - 插件上下文。
   * @param {() => object} resolveOptions - 解析下一次操作所用的选项。
   */
  constructor(ctx, resolveOptions) {
    this.ctx = ctx;
    this.resolveOptions = resolveOptions;
    this.id = PROVIDER_ID;
    /** 当 `sessionMode` 为 `stable` 时，在多次搜索间复用。 */
    this.stableSessionId = randomUUID();
  }

  /**
   * 轻量的本地可用性检查 —— 绝不发起网络调用。已挂载的凭据服务会被乐观对待，
   * 与内置提供方完全一致：如果引用最终未设置，搜索本身会以
   * `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。
   *
   * @returns {boolean} 本提供方是否有理由执行搜索。
   */
  available() {
    const options = this.resolveOptions();
    // 「不覆盖官方配置」会让本提供方变成直通：只有在官方提供方可用时才可用。
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
   * 解析某次操作要用的 API 密钥。从不缓存，因此轮换后的密钥无需重启就能作用到
   * 下一次搜索。
   *
   * @param {object} options - 该次操作的选项快照。
   * @param {AbortSignal | undefined} signal - 调用方的信号。
   * @returns {Promise<string>} API 密钥。
   * @throws {WebSearchError} 解析不到任何密钥时抛 `WEB_PROVIDER_CREDENTIAL_MISSING`。
   */
  async resolveApiKey(options, signal) {
    throwIfAborted(signal);
    if (typeof options.apiKey === 'string' && options.apiKey.length > 0) return options.apiKey;

    // 两个引用都会拿去凭据库尝试，而不只是首选的那个。本插件的规范引用是
    // `OPENCODE_API_KEY`，但存放在改名之前那个名称下的密钥必须继续可用 —— 否则
    // 重命名插件就会悄无声息地把所有既有安装挡在搜索之外。
    const refs = credentialRefs(options);
    const credentials = this.ctx.get('credentials');
    if (credentials !== undefined) {
      for (const ref of refs) {
        try {
          const resolved = await credentials.resolve(ref);
          if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
        } catch {
          // 继续尝试下一个引用，最后再回退到进程环境。
        }
        throwIfAborted(signal);
      }
    }

    for (const ref of refs) {
      const fromEnv = envValue(ref);
      if (fromEnv !== undefined) return fromEnv;
    }

    throw new WebSearchError(
      `OpenCode 网页搜索没有可用的 API 密钥：请把它存入 DSH 凭据库的 ` +
        `${refs.map((ref) => `"${ref}"`).join(' 或 ')} 之下，或设置对应的环境变量，` +
        `或在 web-search-opencode-ds 配置里直接填写 "apiKey"。`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    );
  }

  /**
   * 通过 OpenCode 执行一次搜索。
   *
   * @param {{ query: string, maxResults?: number }} request - seam 的请求。
   * @param {AbortSignal} [signal] - 可选的取消信号。
   * @returns {Promise<{ content?: string, sources: object[], truncated: boolean }>} 归一化后的结果。
   */
  async search(request, signal) {
    const options = this.resolveOptions();
    // 直通模式：把请求交给内置提供方，让它的端点、密钥、模型和搜索预算原样生效。
    if (!options.overrideOfficial) {
      const provider = officialProvider(this.ctx);
      if (provider === undefined) {
        throw new WebSearchError(
          `"${SETTINGS_NAMESPACE}" 被设置为不覆盖官方配置，但 "${OFFICIAL_PROVIDER_ID}" ` +
            `提供方未注册，因此没有可委托的对象。请重新开启「覆盖官方配置」，` +
            `或挂载 @deepseek-ai/dsh-web-search-deepseek。`,
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
   * 一次派发尝试。
   *
   * @param {string} endpoint - 解析出的 Messages 端点。
   * @param {string} apiKey - 解析出的密钥。
   * @param {object} options - 该次操作的选项快照。
   * @param {object} body - 请求体。
   * @param {AbortSignal | undefined} callerSignal - 调用方的信号。
   * @returns {Promise<object>} 归一化后的搜索结果。
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
          // 已实测：在 OpenCode 上真正完成鉴权的是 `x-api-key`；
          // 只发 `Authorization: Bearer` 会得到 401 `Missing API key.`
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
        throw new WebSearchError('OpenCode 网页搜索已中止', 'WEB_ABORTED', {
          cause: callerSignal.reason,
        });
      }
      if (attemptSignal.didTimeout()) {
        throw new WebSearchError(
          `OpenCode 网页搜索在 ${options.timeoutMs}ms 后超时（端点 ${JSON.stringify(endpoint)}）。`,
          'WEB_PROVIDER_ERROR',
          { cause: error, retryable: true },
        );
      }
      throw new WebSearchError(
        `OpenCode 网页搜索请求失败：${String(error)}\n\n该请求使用的端点为 ${JSON.stringify(endpoint)}。`,
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
          `OpenCode 拒绝了本次搜索（HTTP 400），因为该请求没有携带可用的 ` +
            `x-opencode-session 请求头${suffix}。本提供方每次搜索都会生成一个；` +
            `出现这种情况说明该请求头在传输途中被剥离了。`,
          'WEB_PROVIDER_ERROR',
          { retryable: true },
        );
      }
      if (status === 401 || status === 403) {
        throw new WebSearchError(
          `OpenCode 拒绝了该凭据（HTTP ${status}）${suffix}。请检查 ${options.apiKeyEnv} ` +
            `中保存的是有效的 OpenCode 密钥，且该密钥有权使用当前由 ` +
            `goMode 选定的 ${options.goMode ? 'OpenCode Go 套餐' : '按量计费的 OpenCode Zen API'}。` +
            `注意密钥本身会过期：届时正文是 This API key has expired。`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        );
      }
      // 模型换代是真实发生过的故障：Go 套餐曾下架 `deepseek-v4-flash`，让旧默认值
      // 直接失效。端点对"模型不存在"的回应是 400/404，正文里会提到 model，所以这里
      // 把它翻译成可直接执行的建议，而不是笼统的 HTTP 错误。
      if ((status === 400 || status === 404) && /model/iu.test(detail ?? '')) {
        throw new WebSearchError(
          `OpenCode 似乎不认这个模型（HTTP ${status}）${suffix}\n\n` +
            `当前 model 是 ${JSON.stringify(options.model)}，端点是 ${JSON.stringify(endpoint)}。\n` +
            `两条 OpenCode 路由的模型目录并不相同，而且会变——模型下架曾让默认值失效。` +
            `请先查 ${JSON.stringify(`${options.baseURL.replace(/\/+$/u, '')}/models`)} 拿到该端点现有的 id，` +
            `再改「设置 → 插件 → 网页搜索（OpenCode）」里的模型配置。`,
          'WEB_PROVIDER_ERROR',
        );
      }
      if (status === 402) {
        throw new WebSearchError(
          `OpenCode 因账户余额不足拒绝了本次搜索（HTTP 402）${suffix}\n\n` +
            `goMode 处于关闭状态，因此该请求发往了按量计费端点 ${JSON.stringify(endpoint)}。` +
            `请为账户充值，或重新开启 goMode 改为计入包月的 Go 套餐。`,
          'WEB_PROVIDER_ERROR',
        );
      }
      throw new WebSearchError(
        `OpenCode API 错误（HTTP ${status}）${suffix}\n\n该网页搜索请求使用的端点为 ${JSON.stringify(endpoint)}。`,
        'WEB_PROVIDER_ERROR',
        { retryable: RETRYABLE_STATUS.has(status) },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new WebSearchError(
        `OpenCode 返回了无法解析的响应体：${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error, retryable: true },
      );
    }

    return mapAnthropicResponse(payload, { includeAnswer: options.includeAnswer === true });
  }
}

/**
 * 把实时配置投影为一次搜索实际使用的选项。每个值都在这里补齐默认值，因此提供方
 * 从不读取原始的配置字段。
 *
 * @param {object} ctx - 插件上下文。
 * @param {unknown} config - 行配置。
 * @returns {object} 解析出的选项。
 */
export function resolveOptions(ctx, config) {
  const goMode = readOption(config, 'goMode', DEFAULT_GO_MODE) !== false;
  const declaredBaseUrl = readOption(config, 'baseURL', undefined);
  return {
    apiKey: readOption(config, 'apiKey', undefined),
    apiKeyEnv: readOption(config, 'apiKeyEnv', DEFAULT_API_KEY_ENV),
    // 显式指定的 baseURL 始终优先；否则由模式决定端点。
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
 * 某次操作按顺序要尝试的凭据引用。
 *
 * 配置的引用排在最前；另一种规范写法总会被追加，这样存放在任一名称下的密钥都能
 * 解析到。重复项会被去掉。
 *
 * @param {object} options - 该次操作的选项快照。
 * @returns {string[]} 要尝试的引用，最具体的排在最前。
 */
export function credentialRefs(options) {
  const configured = typeof options.apiKeyEnv === 'string' && options.apiKeyEnv.length > 0
    ? options.apiKeyEnv
    : DEFAULT_API_KEY_ENV;
  return [...new Set([configured, DEFAULT_API_KEY_ENV, FALLBACK_API_KEY_ENV])];
}

/**
 * 在 seam 自己的注册表里查找内置的 DeepSeek 提供方。
 *
 * `WebRuntime.searchProviders` 就是一个普通的公开 `Map`，而 seam 在调用时才解析
 * 配置的 id，所以在这里委托是一个实时决定：官方提供方会继续使用它自己那段配置，
 * 这正是「不覆盖官方配置」必须意味着的事情。
 *
 * @param {object} ctx - 插件上下文。
 * @returns {{ search: Function, available: Function } | undefined} 官方提供方（若已挂载）。
 */
function officialProvider(ctx) {
  const web = ctx.get?.('web') ?? ctx.web;
  const registry = web?.searchProviders;
  if (!(registry instanceof Map)) return undefined;
  const provider = registry.get(OFFICIAL_PROVIDER_ID);
  return provider === undefined || provider === null ? undefined : provider;
}

/**
 * 向 `ctx.web` 注册 OpenCode 搜索提供方。
 *
 * @param {object} ctx - 插件上下文，携带 `web` seam。
 * @param {unknown} config - 行配置。
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

  // 本插件自带浏览器表单（`client.js`），因此不使用 schema 自动生成的页面。
  // `auto: false` 只是抑制那次生成 —— 设置服务仍会为该命名空间提供读写。把注册放在
  // `ctx.inject(['settings'], ...)` 里，可以让插件在完全没有设置服务的 profile 中
  // 依然可用，并把该策略绑定到本插件的 fiber 上，使晚加载的 Settings 服务仍会采纳它。
  ctx.inject?.(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'web-search-opencode-ds: 设置页呈现策略',
    );
  });

  const options = resolveOptions(ctx, config);
  ctx.logger?.debug?.(
    'web-search-opencode-ds: 已注册搜索提供方 "%s"（%s；mode=%s, overrideOfficial=%s）',
    PROVIDER_ID,
    provider.available() ? '可用' : '不可用（尚无凭据）',
    options.goMode ? 'go' : 'metered',
    String(options.overrideOfficial),
  );
}
