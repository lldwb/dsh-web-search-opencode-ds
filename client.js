/**
 * `dsh-web-search-opencode-ds` — browser half.
 *
 * A hand-written bundle in the same shape the shipped settings pages ship in:
 * `window.__ModuleLoader__.load({ id, factory })` with a lazy-CJS factory. DSH's
 * modules roster discovers it from this package's `dsh.client` declaration and
 * serves it at `/plugins/dsh-web-search-opencode-ds/client.js`.
 *
 * The page edits the `web-search-opencode-ds` settings namespace, which is the
 * Host half's own `Config` (see index.js). It only mounts while the Host serves
 * that namespace, so a profile without the plugin shows no trace of it.
 *
 * `require` here resolves two specifiers only — `react/jsx-runtime` and
 * `@deepseek-ai/dsh-client-ui-primitives` — both of which are static modules of
 * the shell's own module table. The shipped `@deepseek-ai/dsh-client-ui-settings-web-search`
 * page requires exactly the same pair, which is the evidence they are seeded.
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
    /** English copy. */
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

    /** Simplified Chinese copy. */
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

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.webSearchOpenCode';

    /**
     * The Host settings namespace this page edits. Spelled here rather than
     * imported: a client package must not depend on a Host package. It equals
     * the Loader row id, which is the Host half's `name` export.
     */
    const SETTINGS_NS = 'web-search-opencode-ds';

    /** Credential reference the form writes when the section names none. */
    const DEFAULT_API_KEY_REF = 'OPENCODE_API_KEY';

    /** Form field the credential control stages under. */
    const API_KEY_FIELD = 'apiKey';

    /**
     * A boolean field kind for {@link P.SettingsFormModel}.
     *
     * The shipped field kinds are text and number only; a toggle needs its own,
     * but the contract is small — `format` renders the stored value into the
     * staged text, `parse` turns staged text back into a write.
     *
     * @param field - the config field name.
     * @returns the field spec.
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' })
      };
    }

    /** The labels the shared settings form renders. */
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
     * One switch row. The shipped form has no boolean field component, so this
     * renders the same shape a value field does — label, hint, control — around
     * the exported `Switch` primitive.
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
     * Render the provider's one-liner or its settings form, as the Plugins page asks.
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
     * Bridges the settings scope and the credentials domain onto the page.
     *
     * The key is the one control that does not live in the section: its literal
     * never rides a response, so the page learns only whether one is configured
     * and writes it through the credentials domain, addressed by the reference
     * the section names. It is staged with the rest of the form so one save
     * covers everything the page shows.
     */
    class WebSearchCardController {
      /**
       * @param scope - the bound settings scope for the settings namespace.
       * @param ctx - the page plugin's context.
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

      /** Build the page's snapshot from the form's current reads. */
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
       * Ask the credentials domain about the reference the section currently names.
       *
       * The answer is stored with the reference it describes, so a response only
       * publishes while it still answers for the reference in force.
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

      /** Re-read after the Host reports a change to the reference this page watches. */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return;
        this.readCredential();
      }

      /** Build the face the page's slot registration injects. */
      inject() {
        return {
          hooks: { webSearchCard: this.store },
          ...this.form.actions()
        };
      }

      /** Write the staged key, then re-read whether the Host now holds one. */
      async writeKey(value) {
        await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value);
        await this.readCredential();
        return this.credential.configured;
      }

      /** Release configuration subscriptions. */
      dispose() {
        this.unsubscribe();
        this.form.dispose();
      }
    }

    /** The credential reference the section names, or the provider's default. */
    function refOf(snapshot) {
      const declared = snapshot.value?.apiKeyEnv;
      return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'];

    /**
     * Mount the settings page while the Host serves its namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'web-search-opencode-ds: dictionaries'
      );

      const card = new WebSearchCardController(ctx.configForms.get(SETTINGS_NS), ctx);
      ctx.effect(
        () => () => {
          card.dispose();
        },
        'web-search-opencode-ds: form subscription'
      );
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            card.refreshCredential(ref);
          }),
        'web-search-opencode-ds: credential invalidations'
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'web-search-opencode',
                  // Renders directly after the official Web search card (order 40).
                  order: 41,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject()
                },
                WebSearchCard
              )
            )
          ),
        'web-search-opencode-ds: page'
      );
    }

    exports.NS = NS;
    exports.SETTINGS_NS = SETTINGS_NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
