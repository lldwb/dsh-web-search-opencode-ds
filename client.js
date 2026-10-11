/**
 * `dsh-web-search-opencode-ds` —— 浏览器半。
 *
 * 手写的 bundle，形态与内置设置页一致：`window.__ModuleLoader__.load({ id, factory })`
 * 配一个惰性 CJS 工厂。DSH 的模块清单会根据本包的 `dsh.client` 声明发现它，并在
 * `/plugins/dsh-web-search-opencode-ds/client.js` 上提供它。
 *
 * 该页面编辑的是 `web-search-opencode-ds` 设置命名空间，也就是 Host 半自己的
 * `Config`（见 index.js）。只有当 Host 提供该命名空间时它才会挂载，因此没有装这个
 * 插件的 profile 看不到它的任何痕迹。
 *
 * 这里的 `require` 只解析两个说明符 —— `react/jsx-runtime` 和
 * `@deepseek-ai/dsh-client-ui-primitives` —— 二者都是 shell 自身模块表中的静态模块。
 * 内置的 `@deepseek-ai/dsh-client-ui-settings-web-search` 页面要求的正是同一对，
 * 这就是它们已被预置的证据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-opencode-ds',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react_jsx_runtime = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // #region locales
    /** 英文文案。 */
    const en = {
      title: 'Web search (OpenCode)',
      description: 'Run DeepSeek web search through OpenCode instead of the official endpoint.',
      apiKey: 'API key',
      apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key found for this reference; the provider falls back to it at search time.',
      baseUrl: 'Endpoint',
      baseUrlHint: 'Leave blank to derive it from the mode below.',      maxUses: 'Max searches per request',
      maxUsesHint: 'How many times one request may search before it must answer.',
      overrideOfficial: 'Override the official web-search configuration',
      overrideOfficialHint:
        'On: searches use the endpoint and key configured here. Off: searches are handed to the built-in DeepSeek provider untouched, so its own settings stay in charge.',
      goMode: 'Use the OpenCode Go plan',
      goModeHint:
        'On: the flat-rate Go endpoint (zen/go/v1). Off: the default metered API (zen/v1), billed per use — it needs account funds and answers HTTP 402 without them.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.'
    };

    /** 简体中文文案。 */
    const zh = {
      title: '网页搜索（OpenCode）',
      description: '通过 OpenCode 调用 DeepSeek 网页搜索，替代官方接口地址。',
      apiKey: 'API Key',
      apiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '该引用下未找到密钥；搜索时会再尝试解析一次。',
      baseUrl: '接口地址',
      baseUrlHint: '留空则按下方的模式自动决定。',
      maxUses: '单次请求最多搜索次数',
      maxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
      overrideOfficial: '覆盖官方网页搜索配置',
      overrideOfficialHint:
        '开启：使用这里配置的接口地址与密钥。关闭：把搜索原样交给内置 DeepSeek 提供方，继续沿用它的配置。',
      goMode: '使用 OpenCode Go 套餐',
      goModeHint:
        '开启：走包月 Go 端点（zen/go/v1）。关闭：走默认按量计费 API（zen/v1），按次扣费——账户无余额时会返回 HTTP 402。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。'
    };
    // #endregion

    /** 本插件拥有的词典命名空间。 */
    const NS = 'settings.webSearchOpenCode';

    /**
     * 本页面所编辑的 Host 设置命名空间。在这里写死而不是导入：客户端包不能依赖
     * Host 包。它等于 Loader 行 id，也就是 Host 半的 `name` 导出。
     */
    const SETTINGS_NS = 'web-search-opencode-ds';

    /** 当该区段没有指定引用时，表单写入的凭据引用。 */
    const DEFAULT_API_KEY_REF = 'OPENCODE_API_KEY';

    /** 凭据控件暂存所用的表单字段。 */
    const API_KEY_FIELD = 'apiKey';

    /**
     * {@link P.SettingsFormModel} 用的一种布尔字段类型。
     *
     * 内置的字段类型只有文本和数字；开关需要自己的类型，但契约很小 —— `format` 把
     * 存储值渲染成暂存文本，`parse` 把暂存文本变回一次写入。
     *
     * @param field - 配置字段名。
     * @returns 字段规格。
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' })
      };
    }

    /** 共享设置表单所渲染的标签。 */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving')
      };
    }

    /**
     * 一个开关行。内置表单没有布尔字段组件，因此这里围绕导出的 `Switch` 原语渲染
     * 与数值字段相同的形态 —— 标签、提示、控件。
     */
    function ToggleRow(props) {
      const { t } = props;
      const describedBy = `${props.id}-hint`;
      return react_jsx_runtime.jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' },
        children: [
          react_jsx_runtime.jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '12px' },
            children: [
              react_jsx_runtime.jsx('div', {
                style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
                children: [
                  react_jsx_runtime.jsx('span', {
                    id: props.id,
                    style: { fontSize: '13px', fontWeight: 500 },
                    children: props.label
                  }),
                  props.overridden
                    ? react_jsx_runtime.jsxs('span', {
                        style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
                        children: [
                          react_jsx_runtime.jsx('span', {
                            style: {
                              fontSize: '11px',
                              padding: '1px 6px',
                              borderRadius: '999px',
                              border: '1px solid currentColor',
                              opacity: 0.65
                            },
                            children: t('overridden')
                          }),
                          react_jsx_runtime.jsx('button', {
                            type: 'button',
                            disabled: props.disabled,
                            onClick: props.onReset,
                            style: {
                              fontSize: '11px',
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'inherit',
                              opacity: props.disabled ? 0.4 : 0.7,
                              cursor: props.disabled ? 'default' : 'pointer',
                              textDecoration: 'underline'
                            },
                            children: t('reset')
                          })
                        ]
                      })
                    : null
                ]
              }),
              react_jsx_runtime.jsx(P.Switch, {
                checked: props.checked,
                disabled: props.disabled,
                label: props.label,
                onChange: (next) => {
                  props.onEdit(next === true);
                }
              })
            ]
          }),
          react_jsx_runtime.jsx('p', {
            id: describedBy,
            style: { margin: 0, fontSize: '12px', opacity: 0.6, lineHeight: 1.5 },
            children: props.hint
          })
        ]
      });
    }

    /**
     * 按插件页的要求，渲染提供方的一句话说明或它的设置表单。
     */
    function WebSearchCard(props) {
      const { t } = props;
      const state = props.useWebSearchCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');

      const disabled = !state.writable;
      const valueLabels = {
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber')
      };

      return react_jsx_runtime.jsxs(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          react_jsx_runtime.jsx(P.SettingsSecretField, {
            id: 'plugin-config-open-code-key',
            label: t('apiKey'),
            hint: t('apiKeyHint'),
            disabled: !state.apiKeyWritable,
            text: state.apiKey.text,
            configured: state.apiKeyConfigured,
            stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
            onEdit: (text) => {
              props.edit(API_KEY_FIELD, text);
            }
          }),
          react_jsx_runtime.jsx(P.SettingsValueField, {
            id: 'plugin-config-open-code-endpoint',
            label: t('baseUrl'),
            hint: t('baseUrlHint'),
            ...valueLabels,
            disabled,
            ...state.baseURL,
            onEdit: (text) => {
              props.edit('baseURL', text);
            },
            onReset: () => {
              props.resetField('baseURL');
            }
          }),
          react_jsx_runtime.jsx(P.SettingsValueField, {
            id: 'plugin-config-open-code-max-uses',
            label: t('maxUses'),
            hint: t('maxUsesHint'),
            ...valueLabels,
            numeric: true,
            disabled,
            ...state.maxUses,
            onEdit: (text) => {
              props.edit('maxUses', text);
            },
            onReset: () => {
              props.resetField('maxUses');
            }
          }),
          react_jsx_runtime.jsx(ToggleRow, {
            id: 'plugin-config-open-code-override-official',
            t,
            label: t('overrideOfficial'),
            hint: t('overrideOfficialHint'),
            checked: state.overrideOfficial.text !== 'false',
            overridden: state.overrideOfficial.overridden,
            disabled,
            onEdit: (next) => {
              props.edit('overrideOfficial', next ? 'true' : 'false');
            },
            onReset: () => {
              props.resetField('overrideOfficial');
            }
          }),
          react_jsx_runtime.jsx(ToggleRow, {
            id: 'plugin-config-open-code-go-mode',
            t,
            label: t('goMode'),
            hint: t('goModeHint'),
            checked: state.goMode.text !== 'false',
            overridden: state.goMode.overridden,
            disabled,
            onEdit: (next) => {
              props.edit('goMode', next ? 'true' : 'false');
            },
            onReset: () => {
              props.resetField('goMode');
            }
          })
        ]
      });
    }

    /**
     * 把设置作用域与凭据域桥接到页面上。
     *
     * 密钥是唯一不存放在该区段里的控件：它的字面值从不随响应下发，因此页面只能得知
     * 是否已配置，并通过凭据域写入，寻址用的是该区段指定的引用。它和表单其余部分一起
     * 暂存，这样一次保存就能覆盖页面展示的全部内容。
     */
    class WebSearchCardController {
      /**
       * @param scope - 该设置命名空间已绑定的设置作用域。
       * @param ctx - 页面插件的上下文。
       */
      constructor(scope, ctx) {
        this.scope = scope;
        this.ctx = ctx;
        this.credential = { ref: '', configured: false, writable: true };
        this.form = new P.SettingsFormModel(
          scope,
          [
            P.settingsTextField('baseURL'),
            P.settingsNumberField('maxUses'),
            settingsBooleanField('overrideOfficial'),
            settingsBooleanField('goMode')
          ],
          [
            {
              field: API_KEY_FIELD,
              write: (text) => this.writeKey(text)
            }
          ]
        );
        this.store = this.form.bind(() => this.projection());
        this.unsubscribe = scope.subscribe(() => {
          this.readCredential();
        });
        this.readCredential();
      }

      /** 用表单当前的读取结果构建页面快照。 */
      projection() {
        return {
          ...this.form.shell(),
          baseURL: this.form.field('baseURL'),
          maxUses: this.form.field('maxUses'),
          overrideOfficial: this.form.field('overrideOfficial'),
          goMode: this.form.field('goMode'),
          apiKey: this.form.field(API_KEY_FIELD),
          apiKeyConfigured: this.credential.configured,
          apiKeyWritable: this.credential.writable
        };
      }

      /**
       * 向凭据域询问该区段当前指定的引用。
       *
       * 答案与它所描述的那个引用一起保存，因此只有当响应仍然对应生效中的引用时才会
       * 发布出去。
       */
      async readCredential() {
        const ref = refOf(this.scope.getSnapshot());
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true };
          this.store.set(this.projection());
        }
        let response;
        try {
          response = await this.ctx.remote.credentials.describe([ref]);
        } catch {
          return;
        }
        if (!response?.ok || ref !== refOf(this.scope.getSnapshot())) return;
        const view = response.value[ref];
        const next = {
          ref,
          configured: view?.configured ?? false,
          writable: view?.writable ?? true
        };
        if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
        this.credential = next;
        this.store.set(this.projection());
      }

      /** Host 报告本页面所关注的引用发生变化后重新读取。 */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return;
        this.readCredential();
      }

      /** 构建页面槽位注册所注入的那张「面孔」。 */
      inject() {
        return {
          hooks: { webSearchCard: this.store },
          ...this.form.actions()
        };
      }

      /** 写入暂存的密钥，然后重新读取 Host 现在是否已持有密钥。 */
      async writeKey(value) {
        await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value);
        await this.readCredential();
        return this.credential.configured;
      }

      /** 释放配置订阅。 */
      dispose() {
        this.unsubscribe();
        this.form.dispose();
      }
    }

    /** 该区段指定的凭据引用，未指定时用提供方的默认值。 */
    function refOf(snapshot) {
      const declared = snapshot.value?.apiKeyEnv;
      return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
    }

    /** 必需的服务（cordis fiber inject）。 */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'];

    /**
     * 在 Host 提供其命名空间期间挂载设置页。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'web-search-opencode-ds: 词典'
      );

      const card = new WebSearchCardController(ctx.configForms.get(SETTINGS_NS), ctx);
      ctx.effect(
        () => () => {
          card.dispose();
        },
        'web-search-opencode-ds: 表单订阅'
      );
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            card.refreshCredential(ref);
          }),
        'web-search-opencode-ds: 凭据失效通知'
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'web-search-opencode',
                  // 紧跟在官方网页搜索卡片（order 40）之后渲染。
                  order: 41,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject()
                },
                WebSearchCard
              )
            )
          ),
        'web-search-opencode-ds: 设置页'
      );
    }

    exports.NS = NS;
    exports.SETTINGS_NS = SETTINGS_NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
