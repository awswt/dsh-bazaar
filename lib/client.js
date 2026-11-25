/**
 * 前端两屏：设置页（屏 A）与会话辅助面板（屏 B）。
 *
 * 屏 A「专家库设置」挂在 `settings.section` + `settings.section.icon` 上，按 provider
 * 注册表分页签，每个页签固定四块：账号 / 凭据 / 缓存 / 连接器授权。页签由
 * `GET /dsh-bazaar/providers` 驱动，界面里没有任何写死的 provider 分支。
 *
 * 屏 B 挂在 `conversation.input.left` 上，是本会话的集市面板：上方一多选开关组选
 * 专家库（可选、全不勾选合法），下方按库分组并列显示专家与技能。
 *
 * 三条硬约束写在这里，改代码前先读：
 *
 * 1. **单文件工厂**：本文件必须整体包在 `window.__ModuleLoader__.load({factory})` 里，
 *    不拆成多模块。宿主按工厂函数取 `apply(ctx)`，拆文件会让加载顺序不可控。
 * 2. **hook 只在函数顶层**：每个组件把 `React.use*` 全部放在函数体开头，任何
 *    `return` 都排在所有 hook 之后。面板与页签会因数据到达而重渲染，条件 hook
 *    会让 React 的 hook 顺序错位并整棵子树崩掉（宿主 SlotErrorBoundary 对非链式
 *    槽位不兜底，崩的是输入框旁边那颗按钮）。
 * 3. **状态必须有文字**：颜色只作辅助。禁用要写清「禁用：原因」，只读要写「只读」，
 *    加载中、空数据、出错三者外观必须互相可区分（`test/two-screen-e2e.test.mjs` 断言）。
 *
 * 旧「军械库（armory）」桥接已整体移除：本文件不再探测 `window.__DSH_ARMORY__`、
 * 不再有 catalog 回退分支，也不再拼 `bz-card` 那套市场卡片。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bazaar',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    // 面板用 portal 挂到 body 上，避免被输入框所在的 overflow 容器裁掉。
    // 宿主没给 react-dom 时降级为就地渲染，功能不受影响。
    var createPortal = null
    try {
      var reactDom = require('react-dom')
      createPortal = reactDom !== null && reactDom !== undefined ? reactDom.createPortal : null
    } catch (error) {
      createPortal = null
    }

    var PACKAGE_ID = 'dsh-bazaar'
    // 槽位与顺序是宿主契约，改它们等于让老用户的面板消失。
    var SLOT_NAME = 'conversation.input.left'
    var ENTRY_ID = 'bazaar-expert-picker'
    var ENTRY_ORDER = 26
    var SETTINGS_SLOT = 'settings.section'
    var SETTINGS_ICON_SLOT = 'settings.section.icon'
    // 设置页的正文与图标必须是同一个 id：宿主按 id 把图标对齐到页签，两个 id 会让
    // 图标挂到不存在的段落上（旧版本踩过一次，这里只留一个常量）。
    var SETTINGS_ENTRY_ID = 'bazaar-account'
    var SETTINGS_ENTRY_ORDER = 25
    var STYLE_ID = PACKAGE_ID + '-styles'

    var PREFIX = '/dsh-bazaar'
    var PROVIDER_SEGMENT = '/providers'

    /**
     * 路由常量：前缀统一 `/dsh-bazaar`，provider 维度的读写走 `/providers/<providerId>`。
     *
     * 列表类读（专家 / 技能市场）仍用扁平端点 + `provider` 查询参数：那两个端点在
     * 服务端额外补了「本机已装」与「安装归属」标记（屏 B 的冲突判断靠它），分组段
     * 只补 provider 维度的状态、账号、连接器与写动作。
     */
    var ROUTES = {
      state: PREFIX + '/state',
      experts: PREFIX + '/experts',
      skillMarket: PREFIX + '/skill-market',
      skillInstall: PREFIX + '/skill-install',
      accounts: PREFIX + '/accounts',
      accountsAction: PREFIX + '/accounts/action',
      connectors: PREFIX + '/connectors',
      connectorsSession: PREFIX + '/connectors/session',
      connectorsAction: PREFIX + '/connectors/action',
      select: PREFIX + '/select',
      skills: PREFIX + '/skills',
      off: PREFIX + '/off',
      providers: PREFIX + PROVIDER_SEGMENT,
      providersActive: PREFIX + PROVIDER_SEGMENT + '/active',
      provider: function (providerId) {
        return PREFIX + PROVIDER_SEGMENT + '/' + encodeURIComponent(String(providerId))
      },
      providerStatus: function (providerId) {
        return ROUTES.provider(providerId) + '/status'
      },
      providerAccounts: function (providerId) {
        return ROUTES.provider(providerId) + '/accounts'
      },
      providerAccountsAction: function (providerId) {
        return ROUTES.provider(providerId) + '/accounts/action'
      },
      providerConnectors: function (providerId) {
        return ROUTES.provider(providerId) + '/connectors'
      },
      providerConnectorSession: function (providerId) {
        return ROUTES.provider(providerId) + '/connectors/session'
      },
      providerConnectorAction: function (providerId) {
        return ROUTES.provider(providerId) + '/connectors/action'
      },
      providerCacheClear: function (providerId) {
        return ROUTES.provider(providerId) + '/cache/clear'
      },
      providerExperts: function (providerId) {
        return ROUTES.provider(providerId) + '/experts'
      },
      providerSkillMarket: function (providerId) {
        return ROUTES.provider(providerId) + '/skill-market'
      },
      providerSkillInstall: function (providerId) {
        return ROUTES.provider(providerId) + '/skill-install'
      },
    }

    var inject = ['slots']

    // 颜色与圆角一律取宿主令牌，插件不自造色板；fallback 值只是宿主令牌缺失时的兜底。
    var CSS = [
      '.bz-host,.bz-panel,.bz-settings{',
      '--bz-fg:var(--dsw-alias-label-primary,#0f1115);',
      '--bz-fg-dim:var(--dsw-alias-label-secondary,#61666b);',
      '--bz-err:var(--dsw-alias-state-error-primary,#ec1313);',
      '--bz-bg:var(--dsw-alias-bg-layer-1,#fff);',
      '--bz-bg-alt:var(--dsw-static-neutral-bluish-50,#f9fafb);',
      '--bz-border:var(--dsw-alias-border-l1,rgba(0,0,0,.06));',
      '--bz-mask:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));',
      '--bz-r-sm:var(--dsw-radius-sm,8px);--bz-r-lg:12px;--bz-r-xs:5px;',
      'color:var(--bz-fg);font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      'font-size:13px;line-height:1.55}',
      '.bz-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px}',
      '.bz-note{color:var(--bz-fg-dim);font-size:12px}',
      '.bz-sub{margin:4px 0 0;color:var(--bz-fg-dim);font-size:12px}',
      '.bz-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.bz-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      /* 屏 B 的输入框旁挂件 */
      '.bz-host{display:inline-flex;align-items:center;gap:6px}',
      '.bz-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--bz-border);',
      'border-radius:999px;background:var(--bz-bg);color:var(--bz-fg);font-size:12px;font-weight:500;cursor:pointer}',
      '.bz-pill[data-active="true"]{border-color:var(--bz-fg)}',
      '.bz-pill__icon{display:inline-flex;width:14px;height:14px}',
      '.bz-pill__name{color:var(--bz-fg-dim);max-width:12em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* 面板 */
      '.bz-scrim{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;',
      'background:var(--bz-mask);animation:bz-fade .12s ease-out}',
      '.bz-panel{width:min(920px,calc(100vw - 32px));max-height:min(78vh,720px);display:flex;flex-direction:column;',
      'background:var(--bz-bg);border:1px solid var(--bz-border);border-radius:var(--bz-r-lg) var(--bz-r-lg) 0 0;overflow:hidden;',
      'animation:bz-rise .16s ease-out}',
      '.bz-panel-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:12px 16px;',
      'border-bottom:1px solid var(--bz-border)}',
      '.bz-title{margin:0;font-size:16px;font-weight:600;line-height:1.35}',
      '.bz-panel-body{overflow:auto;padding:0}',
      '.bz-panel-section{padding:12px 16px;border-bottom:1px solid var(--bz-border)}',
      '.bz-panel-section:last-child{border-bottom:0}',
      '.bz-panel-section>h4{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--bz-fg-dim);',
      'display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.bz-panel-foot{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 16px;',
      'border-top:1px solid var(--bz-border)}',
      '.bz-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg);color:var(--bz-fg-dim);cursor:pointer}',
      /* 徽标：颜色只是辅助，文案才是状态 */
      '.bz-tag{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:999px;font-size:11px;',
      'font-weight:600;line-height:1.6;border:1px solid transparent;white-space:nowrap}',
      '.bz-tag[data-kind="ok"]{background:#e6faed;color:#233c2c}',
      '.bz-tag[data-kind="warn"]{background:#fef5e7;color:#27241f}',
      '.bz-tag[data-kind="error"]{background:#fef2f2;color:#570c0c}',
      '.bz-tag[data-kind="danger"]{background:#fef2f2;color:#570c0c;border-color:#f2c7c7}',
      '.bz-tag[data-kind="empty"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim)}',
      '.bz-tag[data-kind="disabled"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim);border-color:var(--bz-border)}',
      '.bz-tag[data-kind="readonly"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim)}',
      '.bz-tag[data-kind="req"]{background:#fef2f2;color:#570c0c}',
      '.bz-tag[data-kind="loading"]{background:#eef2ff;color:#1e2a5a}',
      '.bz-tag[data-kind="optional"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim)}',
      '.bz-tag[data-kind="info"]{background:#eef2ff;color:#1e2a5a}',
      /* 按钮 */
      '.bz-btn{height:30px;padding:0 12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);',
      'background:var(--bz-bg);color:var(--bz-fg);font-size:12px;font-weight:500;cursor:pointer}',
      '.bz-btn:hover:not(:disabled){border-color:var(--bz-fg-dim)}',
      /* 主按钮直接吃宿主语义令牌：brand 令牌在深浅色下会翻转，这里不用它。 */
      '.bz-btn--primary{background:var(--dsw-alias-label-primary,#0f1115);',
      'border-color:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-2,#fff)}',
      '.bz-btn--danger{background:#fef2f2;border-color:#f2c7c7;color:#570c0c}',
      '.bz-btn--quiet{background:transparent;border-color:transparent;color:var(--bz-fg-dim)}',
      '.bz-btn--sm{height:26px;padding:0 10px}',
      '.bz-btn:disabled{cursor:not-allowed;opacity:.55}',
      '.bz-btn[aria-disabled="true"]{cursor:not-allowed}',
      /* 表单字段 */
      '.bz-field{margin:0 0 10px;padding:0 0 0 0}',
      '.bz-field--invalid{padding-left:8px;border-left:3px solid var(--bz-err)}',
      '.bz-field-label{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;font-weight:500;color:var(--bz-fg-dim)}',
      '.bz-field-value{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}',
      '.bz-field-hint{margin:4px 0 0;font-size:12px;color:var(--bz-fg-dim)}',
      '.bz-field-hint--error{color:#570c0c}',
      '.bz-val{display:inline-block}',
      '.bz-mask{letter-spacing:.06em}',
      '.bz-input,.bz-select{height:30px;padding:0 8px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);',
      'background:var(--bz-bg);color:var(--bz-fg);font-size:13px;min-width:0}',
      '.bz-input--grow{flex:1 1 220px}',
      '.bz-input:disabled,.bz-select:disabled{cursor:not-allowed;color:var(--bz-fg-dim);background:var(--bz-bg-alt)}',
      '.bz-input[aria-invalid="true"],.bz-select[aria-invalid="true"]{border-color:var(--bz-err)}',
      '.bz-select{min-width:220px}',
      '.bz-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px}',
      '.bz-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}',
      '.bz-chip{height:24px;padding:0 10px;border:1px solid var(--bz-border);border-radius:999px;',
      'background:var(--bz-bg-alt);color:var(--bz-fg-dim);font-size:11px;font-weight:600;cursor:pointer}',
      '.bz-chip[data-on="true"]{background:var(--bz-bg);color:var(--bz-fg);border-color:var(--bz-fg)}',
      '.bz-active{padding:10px 12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg-alt)}',
      '.bz-details{margin:4px 0 0}',
      '.bz-details>summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--bz-fg-dim);list-style:none}',
      '.bz-details>summary::-webkit-details-marker{display:none}',
      '.bz-details>summary::before{content:"▸ ";font-size:10px}',
      '.bz-details[open]>summary::before{content:"▾ "}',
      /* 状态块：加载 / 空 / 出错三者外观必须能分开 */
      '.bz-state-block{padding:10px 12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg-alt)}',
      '.bz-state-block--error{border-color:#f2c7c7;background:#fef2f2;color:#570c0c}',
      '.bz-state-block--loading{background:var(--bz-bg-alt)}',
      '.bz-state-block b{font-size:13px;font-weight:600}',
      '.bz-skel{height:9px;margin:8px 0 0;border-radius:999px;background:linear-gradient(90deg,#eceef1,#f6f7f8,#eceef1);',
      'background-size:200% 100%;animation:bz-skel 1.2s ease-in-out infinite}',
      '.bz-skel--w40{width:40%}.bz-skel--w60{width:60%}.bz-skel--w80{width:80%}',
      /* 分组：多 provider 并列时分组是唯一的归属边界 */
      '.bz-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}',
      '.bz-group{border:1px solid var(--bz-border);border-radius:var(--bz-r-lg);background:var(--bz-bg);overflow:hidden}',
      '.bz-group[data-muted="true"]{background:var(--bz-bg-alt)}',
      '.bz-group[data-error="true"]{border-color:#f2c7c7}',
      '.bz-group-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:space-between;',
      'padding:8px 10px;border-bottom:1px solid var(--bz-border)}',
      '.bz-gname{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px;font-weight:600}',
      '.bz-group-body{padding:10px}',
      '.bz-group-body[data-error="true"]{background:#fef2f2;color:#570c0c}',
      /* 条目 */
      '.bz-entry{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:8px 0;',
      'border-top:1px solid var(--bz-border)}',
      '.bz-entry:first-child{border-top:0}',
      '.bz-entry-name{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px;font-weight:600}',
      '.bz-entry-desc{margin:2px 0 0;font-size:12px;color:var(--bz-fg-dim)}',
      '.bz-entry-side{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end}',
      /* 开关 */
      '.bz-switch{display:inline-flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--bz-border);',
      'border-radius:999px;background:var(--bz-bg);font-size:12px;cursor:pointer}',
      '.bz-switch input{position:absolute;width:1px;height:1px;opacity:0}',
      '.bz-knob{position:relative;display:inline-block;width:28px;height:16px;border-radius:999px;',
      'background:var(--bz-bg-alt);border:1px solid var(--bz-border);transition:background .12s ease}',
      '.bz-knob::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;',
      'background:var(--bz-fg-dim);transition:transform .12s ease}',
      '.bz-switch input:checked+.bz-knob{background:#e6faed;border-color:#8fd6a8}',
      '.bz-switch input:checked+.bz-knob::after{transform:translateX(12px);background:#233c2c}',
      '.bz-switch input:focus-visible+.bz-knob{outline:2px solid var(--bz-fg);outline-offset:2px}',
      '.bz-switch input:disabled+.bz-knob{opacity:.5}',
      '.bz-switches{display:flex;flex-wrap:wrap;gap:8px}',
      /* 技能列 */
      '.bz-skillwrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}',
      '.bz-skillcol{border:1px solid var(--bz-border);border-radius:var(--bz-r-lg);overflow:hidden}',
      '.bz-skillcol-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;',
      'border-bottom:1px solid var(--bz-border);font-size:13px;font-weight:600}',
      '.bz-skillcol-body{padding:10px}',
      '.bz-source{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:10px 0 6px;font-size:12px;font-weight:600;color:var(--bz-fg-dim)}',
      '.bz-source:first-child{margin-top:0}',
      /* 屏 A */
      '.bz-settings{max-width:1120px;margin:0 auto;padding:0}',
      '.bz-settings__head{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;justify-content:space-between}',
      '.bz-settings__meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--bz-fg-dim);font-size:12px}',
      '.bz-tabs{display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;margin:10px 0;padding-bottom:2px}',
      '.bz-tab{display:inline-flex;gap:6px;align-items:center;height:28px;padding:0 10px;border:1px solid var(--bz-border);',
      'border-radius:999px;background:var(--bz-bg-alt);color:var(--bz-fg-dim);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}',
      '.bz-tab[data-on="true"]{background:var(--bz-bg);color:var(--bz-fg);border-color:var(--bz-fg)}',
      '.bz-tab[data-error="true"]{color:#570c0c;border-color:#f2c7c7}',
      '.bz-pane{border:1px solid var(--bz-border);border-radius:var(--bz-r-lg);padding:12px;background:var(--bz-bg)}',
      '.bz-pane>h4{margin:12px 0 6px;font-size:13px;font-weight:600;color:var(--bz-fg-dim)}',
      '.bz-pane>h4:first-of-type{margin-top:0}',
      '.bz-list{list-style:none;margin:0;padding:0}',
      '.bz-list>li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--bz-border)}',
      '.bz-list>li:first-child{border-top:0}',
      '.bz-empty{padding:14px;border:1px dashed var(--bz-border);border-radius:var(--bz-r-lg);background:var(--bz-bg-alt)}',
      '.bz-empty h4{margin:0 0 6px;font-size:14px;font-weight:600;display:flex;gap:8px;align-items:center}',
      '.bz-error{margin:6px 0 0;color:#570c0c;font-size:12px}',
      '.bz-link{border:0;background:none;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font-size:12px}',
      /* 确认框：危险操作二次确认 */
      '.bz-confirm{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;',
      'background:var(--bz-mask);animation:bz-fade .12s ease-out}',
      '.bz-confirm__box{width:min(480px,calc(100vw - 32px));background:var(--bz-bg);border:1px solid var(--bz-border);',
      'border-radius:var(--bz-r-lg);padding:16px}',
      '.bz-confirm__title{margin:0 0 8px;font-size:14px;font-weight:600}',
      '.bz-confirm__body{margin:0;font-size:13px}',
      '.bz-confirm__actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}',
      '.bz-toast{position:sticky;bottom:0;margin:8px 0 0;padding:8px 10px;border-radius:var(--bz-r-sm);',
      'background:var(--bz-bg-alt);border:1px solid var(--bz-border);font-size:12px}',
      '.bz-toast[data-kind="error"]{background:#fef2f2;border-color:#f2c7c7;color:#570c0c}',
      '@keyframes bz-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes bz-rise{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}',
      '@keyframes bz-skel{0%{background-position:0 0}100%{background-position:-200% 0}}',
      '@media (max-width:860px){.bz-pill__name{display:none}.bz-panel{width:100vw;max-height:88vh}}',
      '@media (max-width:640px){.bz-groups,.bz-skillwrap{grid-template-columns:1fr}}',
      '@media (prefers-reduced-motion:reduce){.bz-panel,.bz-scrim,.bz-confirm,.bz-skel{animation:none}}',
    ].join('')

    // ── 基础设施 ──────────────────────────────────────────────────────────────

    function installStyles() {
      if (typeof document === 'undefined' || document === null) return
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      var host =
        document.head !== null && document.head !== undefined ? document.head : document.body
      if (host !== null && host !== undefined) host.appendChild(style)
    }

    function apiUrl(path) {
      var base = typeof document !== 'undefined' && document !== null ? document.baseURI : undefined
      var text = String(path === undefined || path === null ? '' : path)
      try {
        return new URL(text.replace(/^\/+/, ''), base).toString()
      } catch (error) {
        return text
      }
    }

    function messageOf(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function httpError(code, message, detail) {
      var error = new Error(message)
      error.code = code
      if (detail !== undefined) error.detail = detail
      if (detail !== null && typeof detail === 'object' && typeof detail.field === 'string') {
        error.field = detail.field
      }
      return error
    }

    /** 把非 2xx 与 `{ok:false}` 统一折成带 code/field 的异常，界面只读这两者。 */
    async function requestJson(path, init) {
      var options = init === undefined || init === null ? {} : init
      var response
      try {
        response = await fetch(apiUrl(path), options)
      } catch (error) {
        throw httpError('BAZAAR_NETWORK', '请求没有发出去或没有回应：' + messageOf(error))
      }
      var body
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (body !== null && typeof body === 'object' && body.ok === false) {
        throw httpError(
          typeof body.code === 'string' && body.code !== '' ? body.code : 'HTTP_' + response.status,
          messageOf(body.error === undefined ? body.message : body.error),
          body,
        )
      }
      if (response.ok !== true) {
        throw httpError('HTTP_' + response.status, 'HTTP ' + response.status, body)
      }
      return body === null ? {} : body
    }

    function getJson(path) {
      return requestJson(path, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
    }

    function postJson(path, payload) {
      return requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload === undefined || payload === null ? {} : payload),
      })
    }

    function queryOf(params) {
      var pairs = []
      var keys = Object.keys(params === undefined || params === null ? {} : params)
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index]
        var value = params[key]
        if (value === undefined || value === null || value === '') continue
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      }
      return pairs.length === 0 ? '' : '?' + pairs.join('&')
    }

    function fmtBytes(bytes) {
      var value = Number(bytes)
      if (Number.isFinite(value) !== true || value <= 0) return '0 B'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function fmtTime(ms) {
      var value = Number(ms)
      if (Number.isFinite(value) !== true || value <= 0) return '未知'
      try {
        return new Date(value).toLocaleString()
      } catch (error) {
        return String(value)
      }
    }

    function textOf(value) {
      return String(value === undefined || value === null ? '' : value).trim()
    }

    function copyText(text) {
      var value = String(text === undefined || text === null ? '' : text)
      if (value === '') return Promise.resolve(false)
      try {
        var clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard
        if (
          clipboard !== null &&
          clipboard !== undefined &&
          typeof clipboard.writeText === 'function'
        ) {
          return clipboard.writeText(value).then(function () {
            return true
          })
        }
      } catch (error) {
        return Promise.resolve(false)
      }
      return Promise.resolve(false)
    }

    // 计时器放在工厂顶部：组件卸载后不再持有引用，避免重复定时器。
    var timers = Object.create(null)

    function stopTimer(key) {
      if (timers[key] === undefined) return
      try {
        clearInterval(timers[key])
      } catch (error) {
        void error
      }
      delete timers[key]
    }

    // ── 图标 ──────────────────────────────────────────────────────────────────

    function personIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          fill: 'currentColor',
          d: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1.2c-2.9 0-5.2 1.6-5.2 3.6V14h10.4v-1.2c0-2-2.3-3.6-5.2-3.6z',
        }),
      )
    }

    function closeIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          fill: 'currentColor',
          d: 'M4.2 3.1 3.1 4.2 6.9 8l-3.8 3.8 1.1 1.1L8 9.1l3.8 3.8 1.1-1.1L9.1 8l3.8-3.8-1.1-1.1L8 6.9z',
        }),
      )
    }

    function searchIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          fill: 'currentColor',
          d: 'M7 2a5 5 0 1 0 3.1 8.9l3 3 1-1-3-3A5 5 0 0 0 7 2zm0 1.5A3.5 3.5 0 1 1 7 10.5 3.5 3.5 0 0 1 7 3.5z',
        }),
      )
    }

    // ── 基础组件 ──────────────────────────────────────────────────────────────
    function Tag(props) {
      return h(
        'span',
        { className: 'bz-tag', 'data-kind': props.kind === undefined ? 'info' : props.kind },
        props.children,
      )
    }

    /**
     * 一个字段：标签 + 值 + 说明。`invalid` 时挂 `aria-invalid` 与锚定说明 id，
     * 让「错在哪 / 怎么改」被读屏念出来，而不是只靠红边。
     */
    function Field(props) {
      var errorId = props.errorId === undefined ? null : props.errorId
      return h(
        'div',
        { className: 'bz-field' + (props.invalid === true ? ' bz-field--invalid' : '') },
        h(
          'div',
          { className: 'bz-field-label', id: props.labelId === undefined ? null : props.labelId },
          props.label,
          props.labelTag === undefined || props.labelTag === null ? null : props.labelTag,
        ),
        h('div', { className: 'bz-field-value' }, props.children),
        props.hint === undefined || props.hint === null
          ? null
          : h(
              'p',
              {
                className:
                  'bz-field-hint' + (props.invalid === true ? ' bz-field-hint--error' : ''),
                id: errorId,
              },
              props.hint,
            ),
      )
    }

    function StateBlock(props) {
      var error = props.kind === 'error'
      var loading = props.kind === 'loading'
      var attrs = {
        className:
          'bz-state-block' +
          (error ? ' bz-state-block--error' : loading ? ' bz-state-block--loading' : ''),
        role: error ? 'alert' : 'status',
      }
      if (loading === true) attrs['aria-busy'] = 'true'
      return h('div', attrs, h('b', null, props.title), props.children)
    }

    function Skeleton(props) {
      var widths = props.widths === undefined ? ['w80', 'w60', 'w80'] : props.widths
      var rows = []
      for (var index = 0; index < widths.length; index += 1) {
        rows.push(
          h('div', { key: 'skel-' + index, className: 'bz-skel bz-skel--' + widths[index] }),
        )
      }
      return h('div', { 'aria-hidden': 'true' }, rows)
    }

    function Notice(props) {
      var message = props.notice
      if (message === null || message === undefined || message.text === '') return null
      return h(
        'p',
        {
          className: 'bz-toast',
          'data-kind': message.kind === 'error' ? 'error' : 'ok',
          role: 'status',
        },
        message.text,
      )
    }

    function ConfirmDialog(props) {
      var request = props.request
      if (request === null || request === undefined) return null
      return h(
        'div',
        {
          className: 'bz-confirm',
          role: 'presentation',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) props.onCancel()
          },
        },
        h(
          'div',
          {
            className: 'bz-confirm__box',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': request.title,
          },
          h('h4', { className: 'bz-confirm__title' }, request.title),
          h('p', { className: 'bz-confirm__body' }, request.body),
          h(
            'div',
            { className: 'bz-confirm__actions' },
            h('button', { type: 'button', className: 'bz-btn', onClick: props.onCancel }, '取消'),
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--danger',
                'data-confirm': request.action,
                onClick: props.onConfirm,
              },
              request.confirmLabel,
            ),
          ),
        ),
      )
    }

    // ── 屏 A：设置页 ──────────────────────────────────────────────────────────

    var LOGIN_REGIONS = [
      { value: 'cn', label: '国内版（codebuddy.cn 账号体系）' },
      { value: 'global', label: '国际版（workbuddy.ai 账号体系）' },
    ]

    var REGION_REQUIRED = '请先选择登录区域（国内版 / 国际版）'

    function declares(capabilities, domain) {
      return (
        capabilities !== null && typeof capabilities === 'object' && capabilities[domain] === true
      )
    }

    function declaredList(capabilities) {
      var names = []
      var keys = ['expertMarket', 'skillMarket', 'memoryMarket', 'connectorMarket', 'account']
      for (var index = 0; index < keys.length; index += 1) {
        if (declares(capabilities, keys[index]) === true) names.push(keys[index])
      }
      return names.length === 0 ? '（无）' : names.join(' / ')
    }

    function paneOf(panes, providerId) {
      var pane = panes[providerId]
      if (pane !== undefined) return pane
      return { phase: 'loading', status: null, accounts: null, connectors: null, message: null }
    }

    function uiOf(ui, providerId) {
      var state = ui[providerId]
      if (state !== undefined) return state
      return { region: '', regionError: false, busy: null, notice: null }
    }

    /** 屏 A 的账号块：三种态（未登录 / 登录中 / 已登录）+ 凭据未配置禁用 + 区域必选。 */
    function AccountBlock(props) {
      var provider = props.provider
      var status = props.status
      var accounts = props.accounts
      var ui = props.ui
      var errorId = 'region-' + provider.id + '-err'
      var hintId = 'region-' + provider.id + '-hint'
      if (declares(provider.capabilities, 'account') !== true) {
        return h(
          StateBlock,
          { kind: 'empty', title: '未声明账号能力' },
          h(
            'p',
            { className: 'bz-note' },
            '该 provider 未声明 account 能力：这里不渲染登录入口，调用该域返回 BAZAAR_CAPABILITY_UNDECLARED。',
          ),
        )
      }
      if (accounts === null) {
        return h(
          StateBlock,
          { kind: 'loading', title: '正在读取账号…' },
          h(Skeleton, { widths: ['w60', 'w40'] }),
        )
      }
      if (accounts.phase === 'loading') {
        return h(
          StateBlock,
          { kind: 'loading', title: '正在读取账号…' },
          h(Skeleton, { widths: ['w60', 'w40'] }),
        )
      }
      if (accounts.phase === 'error') {
        return h(
          StateBlock,
          { kind: 'error', title: '账号读取失败' },
          h('p', { className: 'bz-note' }, accounts.message),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--primary bz-btn--sm',
              'data-retry': 'accounts-' + provider.id,
              onClick: function () {
                props.onRetry()
              },
            },
            '重试',
          ),
        )
      }
      var items = Array.isArray(accounts.items) ? accounts.items : []
      var credential = status === null ? null : status.credential
      var configured =
        credential === null || credential === undefined ? true : credential.configured === true
      var login = ui.login
      var rows = []
      if (items.length > 0) {
        rows.push(
          h(
            Field,
            {
              key: 'logged',
              label: '登录状态',
              hint: '账号标识脱敏展示，不可编辑；切换账号请先退出。',
            },
            h(Tag, { kind: 'ok' }, '已登录'),
            h(
              'span',
              { className: 'bz-val bz-mono' },
              items[0].nickname || items[0].accountId || '（未命名账号）',
            ),
            h(Tag, { kind: 'readonly' }, '只读'),
          ),
        )
        rows.push(
          h(
            Field,
            { key: 'region', label: '区域 / 到期' },
            h(
              'span',
              { className: 'bz-val bz-mono' },
              items[0].region === 'global' ? '国际版' : '国内版',
            ),
            h(
              'span',
              { className: 'bz-val bz-mono' },
              items[0].expired === true
                ? 'access token 已过期'
                : '到期 ' + fmtTime(items[0].expiresAt),
            ),
          ),
        )
        rows.push(
          h(
            Field,
            { key: 'logout', label: '操作', hint: '退出登录会二次确认。' },
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--danger bz-btn--sm',
                'data-logout': provider.id,
                onClick: function () {
                  props.onLogout(items[0])
                },
              },
              '退出登录',
            ),
            h(Tag, { kind: 'danger' }, '危险'),
          ),
        )
        return h('div', null, rows)
      }
      rows.push(
        h(
          Field,
          {
            key: 'state',
            label: '登录状态',
            hint: '未登录不影响该库的公开条目（专家 / 技能市场快照仍可取）。',
          },
          h(Tag, { kind: 'empty' }, '未登录'),
        ),
      )
      if (login !== undefined && login !== null) {
        rows.push(
          h(
            'div',
            { key: 'waiting', className: 'bz-active' },
            h('p', { className: 'bz-note' }, '等待你在浏览器里完成扫码；loginId ' + login.loginId),
            login.url === undefined || login.url === null
              ? null
              : h(
                  'p',
                  null,
                  h(
                    'a',
                    {
                      className: 'bz-mono',
                      href: login.url,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    },
                    login.url,
                  ),
                ),
            h(
              'div',
              { className: 'bz-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--primary bz-btn--sm',
                  'data-login-poll': provider.id,
                  onClick: function () {
                    props.onPoll()
                  },
                },
                '我已完成',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--sm',
                  'data-login-cancel': provider.id,
                  onClick: function () {
                    props.onCancelLogin()
                  },
                },
                '取消',
              ),
            ),
          ),
        )
      } else {
        rows.push(
          h(
            Field,
            {
              key: 'region-select',
              label: '登录区域',
              labelTag: h(Tag, { kind: 'req' }, '必选'),
              invalid: ui.regionError === true,
              labelId: 'region-' + provider.id + '-label',
              errorId: ui.regionError === true ? errorId : hintId,
              hint:
                ui.regionError === true
                  ? '错在哪：尚未选择登录区域，无法确定令牌该发往哪套上游账号体系。怎么改：在左侧下拉里选「国内版」或「国际版」后再点登录（服务端同样以 BAZAAR_PARAM_INVALID 拒绝缺失 region 的请求）。'
                  : '区域决定令牌发往哪套上游账号体系，选错等于把令牌发错主机；国内版与国际版是独立账号体系，不能互换。默认不预选。',
            },
            h(
              'select',
              {
                className: 'bz-select',
                'data-region': provider.id,
                required: true,
                'aria-required': 'true',
                'aria-label': '登录区域（必选）',
                'aria-invalid': ui.regionError === true ? 'true' : 'false',
                'aria-describedby': ui.regionError === true ? errorId : hintId,
                value: ui.region === undefined ? '' : ui.region,
                onChange: function (event) {
                  props.onRegion(event.target.value)
                },
              },
              h('option', { value: '' }, '请选择（国内版 / 国际版）'),
              LOGIN_REGIONS.map(function (option) {
                return h('option', { key: option.value, value: option.value }, option.label)
              }),
            ),
          ),
        )
        rows.push(
          h(
            Field,
            {
              key: 'login-action',
              label: '操作',
              hint:
                configured === true
                  ? null
                  : '禁用原因：该 provider 的凭据 ' +
                    textOf(credential === null ? '' : credential.name) +
                    ' 尚未配置，登录必然失败，故不开放入口。',
            },
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                'data-login': provider.id,
                disabled: configured !== true || ui.busy === 'login',
                'aria-disabled': configured === true ? 'false' : 'true',
                'aria-describedby': configured === true ? null : 'login-why-' + provider.id,
                onClick: function () {
                  props.onLogin()
                },
              },
              ui.busy === 'login' ? '登录中…' : '登录',
            ),
            configured === true ? null : h(Tag, { kind: 'disabled' }, '禁用：凭据未配置'),
            configured === true
              ? null
              : h(
                  'span',
                  { className: 'bz-sr', id: 'login-why-' + provider.id },
                  '禁用原因：凭据未配置',
                ),
          ),
        )
      }
      return h('div', null, rows)
    }

    function CredentialBlock(props) {
      var provider = props.provider
      var status = props.status
      if (status === null) {
        return h(
          StateBlock,
          { kind: 'loading', title: '正在读取凭据状态…' },
          h(Skeleton, { widths: ['w60'] }),
        )
      }
      var credential = status.credential
      var configured = credential.configured === true
      var errorId = 'cred-' + provider.id + '-err'
      var labelId = 'cred-' + provider.id + '-label'
      var rows = [
        h(
          Field,
          {
            key: 'name',
            label: '凭证名',
            hint: '由 providerId 推导（默认 BAZAAR_<ID>_TOKEN），可被 providers.<id>.credentialRef 覆盖。',
          },
          h('code', { className: 'bz-mono' }, credential.name),
          h(Tag, { kind: 'readonly' }, '只读'),
        ),
        h(
          Field,
          { key: 'configured', label: '是否已配置' },
          h(Tag, { kind: configured ? 'ok' : 'empty' }, configured ? '已配置' : '未配置'),
          h(
            'span',
            { className: 'bz-note' },
            '模式 ' + textOf(credential.mode) + ' · 来源 ' + textOf(credential.source),
          ),
        ),
      ]
      if (configured === true) {
        rows.push(
          h(
            Field,
            {
              key: 'value',
              label: '值',
              labelId: labelId,
              labelTag: h(Tag, { kind: 'readonly' }, '只读'),
              hint: '值永不回显、不可在此编辑；请到宿主凭据服务中维护。配置里出现内联密钥会被拒绝（BAZAAR_AUTH_INLINE）。',
            },
            h(
              'span',
              {
                role: 'textbox',
                'aria-readonly': 'true',
                'aria-labelledby': labelId,
                className: 'bz-val bz-mono bz-mask',
              },
              textOf(credential.masked) === '' ? '••••••' : credential.masked,
            ),
          ),
        )
      } else {
        rows.push(
          h(
            Field,
            {
              key: 'value',
              label: '值',
              labelId: labelId,
              labelTag: h(Tag, { kind: 'error' }, '出错'),
              invalid: true,
              errorId: errorId,
              hint:
                '错在哪：该 provider 的 ' +
                textOf(credential.name) +
                ' 尚未在宿主凭据服务中写入。怎么改：打开宿主凭据设置，新建名为 ' +
                textOf(credential.name) +
                ' 的条目并粘贴令牌；保存后回到本页。未配置前该库的在线市场与账号相关入口保持禁用（错误码 BAZAAR_AUTH_MISSING）。',
            },
            h(
              'span',
              {
                role: 'textbox',
                'aria-readonly': 'true',
                'aria-invalid': 'true',
                'aria-labelledby': labelId,
                'aria-describedby': errorId,
                className: 'bz-val',
              },
              '未配置凭证',
            ),
          ),
        )
      }
      return h('div', null, rows)
    }

    function CacheBlock(props) {
      var provider = props.provider
      var status = props.status
      if (status === null) {
        return h(
          StateBlock,
          { kind: 'loading', title: '正在统计缓存…' },
          h(Skeleton, { widths: ['w40'] }),
        )
      }
      var cache = status.cache
      var bytes = Number(cache.bytes)
      var hasCache = Number.isFinite(bytes) === true && bytes > 0
      return h(
        'div',
        null,
        h(
          Field,
          {
            label: '占用',
            hint: '目录：' + textOf(cache.dir) + (cache.truncated === true ? '（统计已截断）' : ''),
          },
          h('span', { className: 'bz-val bz-mono' }, fmtBytes(bytes)),
          h(
            'span',
            { className: 'bz-note' },
            '共 ' + String(cache.entries === undefined ? 0 : cache.entries) + ' 个条目',
          ),
        ),
        h(
          Field,
          {
            label: '清理',
            hint:
              hasCache === true
                ? '清理会删除该专家库的缓存目录，下次取数需重新拉取；需二次确认。'
                : '禁用原因：该 provider 目前没有缓存占用。',
          },
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--danger bz-btn--sm',
              'data-clear-cache': provider.id,
              disabled: hasCache !== true,
              'aria-disabled': hasCache === true ? 'false' : 'true',
              'aria-describedby': hasCache === true ? null : 'cache-why-' + provider.id,
              onClick: function () {
                props.onClearCache()
              },
            },
            '清理缓存',
          ),
          h(Tag, { kind: 'danger' }, '危险'),
          hasCache === true ? null : h(Tag, { kind: 'disabled' }, '禁用：当前无缓存'),
          hasCache === true
            ? null
            : h(
                'span',
                { className: 'bz-sr', id: 'cache-why-' + provider.id },
                '禁用原因：该 provider 目前没有缓存占用。',
              ),
        ),
      )
    }

    function ConnectorBlock(props) {
      var provider = props.provider
      var status = props.status
      var connectors = props.connectors
      if (declares(provider.capabilities, 'connectorMarket') !== true) {
        return h(
          StateBlock,
          { kind: 'empty', title: '未声明连接器能力' },
          h(
            'p',
            { className: 'bz-note' },
            '该 provider 未声明 connectorMarket 能力，本块不渲染连接器列表。',
          ),
        )
      }
      if (connectors === null || connectors.phase === 'loading') {
        return h(
          StateBlock,
          { kind: 'loading', title: '正在读取连接器…' },
          h(Skeleton, { widths: ['w80', 'w60'] }),
        )
      }
      if (connectors.phase === 'error') {
        return h(
          StateBlock,
          { kind: 'error', title: '连接器读取失败' },
          h('p', { className: 'bz-note' }, connectors.message),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--primary bz-btn--sm',
              'data-retry': 'connectors-' + provider.id,
              onClick: function () {
                props.onRetry()
              },
            },
            '重试',
          ),
        )
      }
      var items = Array.isArray(connectors.items) ? connectors.items : []
      var providerActive =
        status === null || status.provider === undefined ? null : status.provider.active
      var inactive = providerActive === false
      if (items.length === 0) {
        return h(
          StateBlock,
          { kind: 'empty', title: '没有可用连接器' },
          h('p', { className: 'bz-note' }, '该 provider 当前没有返回连接器条目。'),
        )
      }
      var rows = items.map(function (item) {
        var state = item.state === undefined || item.state === null ? {} : item.state
        var connecting = state.connecting === true
        var authorized = state.connected === true
        var reason = state.reason === undefined || state.reason === null ? null : state.reason
        var stateTag = connecting
          ? h(Tag, { kind: 'loading' }, '授权中')
          : authorized
            ? h(Tag, { kind: 'ok' }, '已授权')
            : h(Tag, { kind: 'warn' }, '需授权')
        var actions = []
        if (authorized === true) {
          actions.push(h(Tag, { key: 'ro', kind: 'readonly' }, '只读'))
          actions.push(
            h(
              'button',
              {
                key: 'copy',
                type: 'button',
                className: 'bz-btn bz-btn--sm',
                'data-copy-config': provider.id + ':' + item.id,
                disabled: inactive,
                onClick: function () {
                  props.onCopyConfig(item)
                },
              },
              '复制配置片段',
            ),
          )
          actions.push(
            h(
              'button',
              {
                key: 'revoke',
                type: 'button',
                className: 'bz-btn bz-btn--danger bz-btn--sm',
                'data-revoke': provider.id + ':' + item.id,
                disabled: inactive,
                onClick: function () {
                  props.onRevoke(item)
                },
              },
              '清除授权',
            ),
          )
        } else {
          actions.push(
            h(
              'button',
              {
                key: 'authorize',
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                'data-authorize': provider.id + ':' + item.id,
                disabled: inactive || connecting,
                'aria-disabled': inactive || connecting ? 'true' : 'false',
                onClick: function () {
                  props.onAuthorize(item)
                },
              },
              connecting ? '授权中…' : '授权',
            ),
          )
        }
        return h(
          'li',
          { key: item.id },
          h('span', { className: 'bz-val bz-mono' }, item.name === undefined ? item.id : item.name),
          h(
            'span',
            { className: 'bz-note' },
            textOf(item.transport) === ''
              ? 'transport 未知'
              : item.transport +
                  ' · ' +
                  String(item.tools === undefined ? 0 : item.tools) +
                  ' 个工具',
          ),
          stateTag,
          inactive === true ? h(Tag, { kind: 'disabled' }, '该专家库未启用') : null,
          reason === null ? null : h('span', { className: 'bz-note' }, textOf(reason.message)),
          h('div', { className: 'bz-entry-side' }, actions),
        )
      })
      return h(
        'div',
        null,
        h('ul', { className: 'bz-list' }, rows),
        h(
          'p',
          { className: 'bz-field-hint' },
          inactive === true
            ? '禁用原因：该专家库在当前会话未启用，授权动作不会生效；先在会话面板勾选它。'
            : '1.0.0 只提供列表 / 筛选 / 详情 / OAuth 授权 / 复制配置片段；写入宿主配置并重载留待 1.1.0，本页不提供该入口。',
        ),
      )
    }

    function SettingsPane(props) {
      var provider = props.provider
      var pane = props.pane
      var head = h(
        'div',
        { className: 'bz-settings__head' },
        h(
          'h3',
          { className: 'bz-title' },
          provider.displayName,
          ' ',
          h(Tag, { kind: 'readonly' }, provider.id),
        ),
        h(
          'div',
          { className: 'bz-settings__meta' },
          h('span', null, '已声明：' + declaredList(provider.capabilities)),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--quiet bz-btn--sm',
              'data-replay-settings': provider.id,
              onClick: function () {
                props.onRetry()
              },
            },
            '重放加载态',
          ),
        ),
      )
      if (pane.phase === 'loading') {
        return h(
          'div',
          {
            className: 'bz-pane',
            role: 'tabpanel',
            id: 'pane-' + provider.id,
            'aria-labelledby': 'tab-' + provider.id,
          },
          head,
          h(
            StateBlock,
            { kind: 'loading', title: '加载中' },
            h(Skeleton, { widths: ['w60', 'w80', 'w40'] }),
            h(
              'div',
              { className: 'bz-row' },
              h(
                'span',
                { className: 'bz-note' },
                '只加载当前页签的内容；其他页签的加载状态不受影响。',
              ),
            ),
          ),
        )
      }
      if (pane.phase === 'error') {
        return h(
          'div',
          {
            className: 'bz-pane',
            role: 'tabpanel',
            id: 'pane-' + provider.id,
            'aria-labelledby': 'tab-' + provider.id,
          },
          head,
          h(
            StateBlock,
            { kind: 'error', title: provider.displayName + ' 加载失败' },
            h('p', { className: 'bz-note' }, pane.message),
            h(
              'div',
              { className: 'bz-row' },
              h(
                'span',
                { className: 'bz-note' },
                '只有本页签内容报错；页签条仍可切换，其他专家库不受影响，也不隐藏本页签。',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--primary bz-btn--sm',
                  'data-retry-settings': provider.id,
                  onClick: function () {
                    props.onRetry()
                  },
                },
                '重试',
              ),
            ),
          ),
        )
      }
      return h(
        'div',
        {
          className: 'bz-pane',
          role: 'tabpanel',
          id: 'pane-' + provider.id,
          'aria-labelledby': 'tab-' + provider.id,
        },
        head,
        h('h4', null, '账号'),
        h(AccountBlock, {
          provider: provider,
          status: pane.status,
          accounts: pane.accounts,
          ui: props.ui,
          onRegion: props.onRegion,
          onLogin: props.onLogin,
          onPoll: props.onPoll,
          onCancelLogin: props.onCancelLogin,
          onLogout: props.onLogout,
          onRetry: props.onRetryAccounts,
        }),
        h('h4', null, '凭据'),
        h(CredentialBlock, { provider: provider, status: pane.status }),
        h('h4', null, '缓存'),
        h(CacheBlock, {
          provider: provider,
          status: pane.status,
          onClearCache: props.onClearCache,
        }),
        h('h4', null, '连接器授权'),
        h(ConnectorBlock, {
          provider: provider,
          status: pane.status,
          connectors: pane.connectors,
          onAuthorize: props.onAuthorize,
          onRevoke: props.onRevoke,
          onCopyConfig: props.onCopyConfig,
          onRetry: props.onRetryConnectors,
        }),
      )
    }

    /**
     * 屏 A 容器：注册表驱动页签 + 每页签独立加载状态。
     *
     * 加载状态按 providerId 分键存放（`panes`），所以「切页签」只是换渲染对象，
     * 不会把别的 provider 的 loading/error 状态一起重置。
     */
    function SettingsScreen(props) {
      var listPair = React.useState({
        phase: 'loading',
        items: [],
        activeProviders: [],
        defaultProvider: null,
        message: null,
      })
      var list = listPair[0]
      var setList = listPair[1]
      var activePair = React.useState(null)
      var active = activePair[0]
      var setActive = activePair[1]
      var panesPair = React.useState({})
      var panes = panesPair[0]
      var setPanes = panesPair[1]
      var uiPair = React.useState({})
      var ui = uiPair[0]
      var setUi = uiPair[1]
      var confirmPair = React.useState(null)
      var confirm = confirmPair[0]
      var setConfirm = confirmPair[1]
      var noticePair = React.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]

      var patchPane = React.useCallback(function (providerId, patch) {
        setPanes(function (previous) {
          var next = Object.assign({}, previous)
          next[providerId] = Object.assign({}, previous[providerId], patch)
          return next
        })
      }, [])

      var patchUi = React.useCallback(function (providerId, patch) {
        setUi(function (previous) {
          var next = Object.assign({}, previous)
          next[providerId] = Object.assign({}, previous[providerId], patch)
          return next
        })
      }, [])

      var showNotice = React.useCallback(function (text, kind) {
        var payload = { text: text, kind: kind === undefined ? 'ok' : kind }
        setNotice(payload)
        return payload
      }, [])

      var loadProviders = React.useCallback(
        async function () {
          setList(function (previous) {
            return Object.assign({}, previous, { phase: 'loading', message: null })
          })
          try {
            var body = await getJson(ROUTES.providers + queryOf({ sessionId: props.sessionId }))
            var items = Array.isArray(body.items) ? body.items : []
            setList({
              phase: 'ready',
              items: items,
              activeProviders: Array.isArray(body.activeProviders) ? body.activeProviders : [],
              defaultProvider: body.defaultProvider === undefined ? null : body.defaultProvider,
              message: null,
            })
            setActive(function (previous) {
              if (previous !== null) {
                for (var index = 0; index < items.length; index += 1) {
                  if (items[index].id === previous) return previous
                }
              }
              return items.length === 0 ? null : items[0].id
            })
          } catch (error) {
            setList({
              phase: 'error',
              items: [],
              activeProviders: [],
              defaultProvider: null,
              message: messageOf(error),
            })
          }
        },
        [props.sessionId],
      )

      var loadPane = React.useCallback(
        async function (providerId) {
          patchPane(providerId, { phase: 'loading', message: null })
          var results = await Promise.all([
            getJson(
              ROUTES.providerStatus(providerId) + queryOf({ sessionId: props.sessionId }),
            ).then(
              function (body) {
                return { ok: true, body: body }
              },
              function (error) {
                return { ok: false, error: error }
              },
            ),
            getJson(
              ROUTES.providerAccounts(providerId) + queryOf({ sessionId: props.sessionId }),
            ).then(
              function (body) {
                return { ok: true, body: body }
              },
              function (error) {
                return { ok: false, error: error }
              },
            ),
            getJson(
              ROUTES.providerConnectors(providerId) + queryOf({ sessionId: props.sessionId }),
            ).then(
              function (body) {
                return { ok: true, body: body }
              },
              function (error) {
                return { ok: false, error: error }
              },
            ),
          ])
          var statusResult = results[0]
          if (statusResult.ok !== true) {
            // 状态是这页的骨架：它失败，页签进错误态（内容不渲染假数据）。
            patchPane(providerId, { phase: 'error', message: messageOf(statusResult.error) })
            return
          }
          patchPane(providerId, {
            phase: 'ready',
            message: null,
            status: statusResult.body,
            accounts: paneEntries(results[1]),
            connectors: paneEntries(results[2]),
          })
        },
        [patchPane, props.sessionId],
      )

      /**
       * 把 `{groups:[…]}` / `{items:[…]}` 折成「一个 provider 的条目 + 相位」。
       *
       * 分组段返回的组带自己的 status：`undeclared` 是「能力未声明」（不是故障，
       * 页面按能力徽标渲染），只有 `error` 才算这块出错。
       */
      function paneEntries(result) {
        if (result.ok !== true)
          return { phase: 'error', items: [], message: messageOf(result.error) }
        var body = result.body === undefined || result.body === null ? {} : result.body
        var groups = Array.isArray(body.groups) ? body.groups : []
        if (groups.length > 0 && groups[0].status === 'error') {
          return { phase: 'error', items: [], message: messageOf(groups[0].message) }
        }
        if (groups.length > 0 && groups[0].status === 'undeclared') {
          return {
            phase: 'ready',
            items: [],
            undeclared: true,
            message: messageOf(groups[0].message),
          }
        }
        var items = []
        if (groups.length > 0) {
          for (var index = 0; index < groups.length; index += 1) {
            if (Array.isArray(groups[index].items)) items = items.concat(groups[index].items)
          }
        } else if (Array.isArray(body.items)) {
          items = body.items
        }
        return { phase: 'ready', items: items, message: null }
      }

      var reloadAccounts = React.useCallback(
        async function (providerId) {
          try {
            var body = await getJson(
              ROUTES.providerAccounts(providerId) + queryOf({ sessionId: props.sessionId }),
            )
            patchPane(providerId, { accounts: paneEntries({ ok: true, body: body }) })
          } catch (error) {
            patchPane(providerId, {
              accounts: { phase: 'error', items: [], message: messageOf(error) },
            })
          }
        },
        [patchPane, props.sessionId],
      )

      var reloadConnectors = React.useCallback(
        async function (providerId) {
          try {
            var body = await getJson(
              ROUTES.providerConnectors(providerId) + queryOf({ sessionId: props.sessionId }),
            )
            patchPane(providerId, { connectors: paneEntries({ ok: true, body: body }) })
          } catch (error) {
            patchPane(providerId, {
              connectors: { phase: 'error', items: [], message: messageOf(error) },
            })
          }
        },
        [patchPane, props.sessionId],
      )

      var runConnectorAction = React.useCallback(
        async function (providerId, item, action) {
          try {
            var body = await postJson(ROUTES.providerConnectorAction(providerId), {
              action: action,
              connectorId: item.id,
              sessionId: props.sessionId,
            })
            if (action === 'copy-config') {
              var snippet = textOf(body.text) === '' ? textOf(body.config) : body.text
              var copied = await copyText(snippet)
              showNotice(
                copied === true
                  ? '配置片段已复制（只产出文本，不改宿主配置）'
                  : '配置片段：' + snippet,
              )
            } else {
              showNotice(
                action === 'remove'
                  ? '已清除授权：该连接器的工具随即不可用，需要时须重新授权。'
                  : '已发起授权，请按提示完成。',
              )
            }
            await reloadConnectors(providerId)
          } catch (error) {
            showNotice(messageOf(error), 'error')
          }
        },
        [props.sessionId, reloadConnectors, showNotice],
      )

      var pollLogin = React.useCallback(
        async function (providerId, loginId) {
          try {
            var body = await postJson(ROUTES.providerAccountsAction(providerId), {
              action: 'poll',
              loginId: loginId,
              sessionId: props.sessionId,
            })
            var result = body.result === undefined || body.result === null ? {} : body.result
            if (result.code !== undefined)
              throw httpError(String(result.code), messageOf(result.error), result)
            if (result.done !== true) return
            stopTimer('login:' + providerId)
            patchUi(providerId, { login: null, busy: null })
            if (typeof result.error === 'string' && result.error !== '') {
              showNotice('登录失败：' + result.error, 'error')
            } else {
              showNotice('登录成功：已保存该专家库的账号。')
            }
            await reloadAccounts(providerId)
            void loadPane(providerId)
          } catch (error) {
            stopTimer('login:' + providerId)
            patchUi(providerId, { login: null, busy: null })
            showNotice('登录失败：' + messageOf(error), 'error')
          }
        },
        [loadPane, patchUi, props.sessionId, reloadAccounts, showNotice],
      )

      var startLogin = React.useCallback(
        async function (providerId) {
          var state = uiOf(ui, providerId)
          var region = textOf(state.region)
          if (region !== 'cn' && region !== 'global') {
            // 未选区域：就地报错、聚焦下拉、一个请求都不发（服务端同样会拒）。
            patchUi(providerId, { regionError: true })
            showNotice(REGION_REQUIRED, 'error')
            if (typeof document !== 'undefined' && document !== null) {
              var select = document.querySelector('[data-region="' + providerId + '"]')
              if (select !== null && typeof select.focus === 'function') select.focus()
            }
            return
          }
          patchUi(providerId, { busy: 'login', notice: null })
          try {
            var body = await postJson(ROUTES.providerAccountsAction(providerId), {
              action: 'login',
              region: region,
              sessionId: props.sessionId,
            })
            var result = body.result === undefined || body.result === null ? {} : body.result
            if (result.code !== undefined)
              throw httpError(String(result.code), messageOf(result.error), result)
            if (typeof result.loginId !== 'string' || result.loginId === '') {
              throw httpError(
                'BAZAAR_LOGIN_UNEXPECTED',
                '登录申请没有返回 loginId：' + JSON.stringify(result),
              )
            }
            patchUi(providerId, {
              busy: null,
              login: {
                loginId: result.loginId,
                url: result.verificationUri === undefined ? null : result.verificationUri,
                region: result.region,
              },
            })
            stopTimer('login:' + providerId)
            timers['login:' + providerId] = setInterval(function () {
              void pollLogin(providerId, result.loginId)
            }, 1500)
          } catch (error) {
            patchUi(providerId, { busy: null })
            showNotice('登录没有发起：' + messageOf(error), 'error')
          }
        },
        [patchUi, pollLogin, props.sessionId, showNotice, ui],
      )

      var cancelLogin = React.useCallback(
        async function (providerId) {
          var state = uiOf(ui, providerId)
          var login = state.login
          stopTimer('login:' + providerId)
          patchUi(providerId, { login: null, busy: null })
          if (login === undefined || login === null) return
          try {
            await postJson(ROUTES.providerAccountsAction(providerId), {
              action: 'cancel',
              loginId: login.loginId,
              sessionId: props.sessionId,
            })
            showNotice('已取消这次登录申请。')
          } catch (error) {
            showNotice('取消失败：' + messageOf(error), 'error')
          }
        },
        [patchUi, props.sessionId, showNotice, ui],
      )

      React.useEffect(
        function () {
          void loadProviders()
          return function () {
            var keys = Object.keys(timers)
            for (var index = 0; index < keys.length; index += 1) stopTimer(keys[index])
          }
        },
        [loadProviders],
      )

      React.useEffect(
        function () {
          if (active === null) return
          if (panes[active] !== undefined) return
          void loadPane(active)
        },
        [active, loadPane, panes],
      )

      var confirmRequest = confirm
      var currentProvider = null
      for (var index = 0; index < list.items.length; index += 1) {
        if (list.items[index].id === active) currentProvider = list.items[index]
      }
      var currentPane = active === null ? null : paneOf(panes, active)
      var currentUi = active === null ? null : uiOf(ui, active)

      function requestConfirm(request) {
        setConfirm(request)
      }

      function handleClearCache() {
        if (currentProvider === null || currentPane === null || currentPane.status === null) return
        var cache = currentPane.status.cache
        var providerId = currentProvider.id
        requestConfirm({
          title: '清理 ' + currentProvider.displayName + ' 的缓存',
          body:
            '将删除 ' +
            textOf(cache.dir) +
            ' 下的 ' +
            String(cache.entries) +
            ' 个条目（' +
            fmtBytes(cache.bytes) +
            '）。下次取数需重新拉取，其他专家库不受影响。',
          confirmLabel: '清理缓存',
          action: 'clear-cache',
          run: async function () {
            try {
              var body = await postJson(ROUTES.providerCacheClear(providerId), {
                sessionId: props.sessionId,
              })
              showNotice(
                '已清理 ' +
                  fmtBytes(cache.bytes) +
                  ' 缓存（移除 ' +
                  String(body.removedEntries) +
                  ' 个条目）。',
              )
              await loadPane(providerId)
            } catch (error) {
              showNotice('清理失败：' + messageOf(error), 'error')
            }
          },
        })
      }

      function handleLogout(item) {
        if (currentProvider === null) return
        var providerId = currentProvider.id
        var displayName = currentProvider.displayName
        requestConfirm({
          title: '退出 ' + displayName + ' 的账号',
          body: '将删除该专家库账号目录下的登录记录，之后需要重新扫码登录。当前会话的选择不受影响。',
          confirmLabel: '退出登录',
          action: 'logout',
          run: async function () {
            try {
              await postJson(ROUTES.providerAccountsAction(providerId), {
                action: 'remove',
                accountId: item.accountId,
                sessionId: props.sessionId,
              })
              showNotice('已退出登录，请重新登录。')
              await reloadAccounts(providerId)
              await loadPane(providerId)
            } catch (error) {
              showNotice('退出失败：' + messageOf(error), 'error')
            }
          },
        })
      }

      if (list.phase === 'loading') {
        return h(
          'div',
          { className: 'bz-settings' },
          h('h3', { className: 'bz-title' }, '专家库设置'),
          h(
            StateBlock,
            { kind: 'loading', title: '正在读取专家库注册表…' },
            h(Skeleton, { widths: ['w60', 'w80'] }),
          ),
          h(Notice, { notice: notice }),
        )
      }
      if (list.phase === 'error') {
        return h(
          'div',
          { className: 'bz-settings' },
          h('h3', { className: 'bz-title' }, '专家库设置'),
          h(
            StateBlock,
            { kind: 'error', title: '专家库注册表读取失败' },
            h('p', { className: 'bz-note' }, list.message),
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                onClick: function () {
                  void loadProviders()
                },
              },
              '重试',
            ),
          ),
          h(Notice, { notice: notice }),
        )
      }
      if (list.items.length === 0) {
        return h(
          'div',
          { className: 'bz-settings' },
          h('h3', { className: 'bz-title' }, '专家库设置'),
          h(
            'div',
            { className: 'bz-empty' },
            h('h4', null, '暂无已注册的专家库', ' ', h(Tag, { kind: 'empty' }, '空数据')),
            h(
              'p',
              { className: 'bz-sub' },
              '注册表为空。安装并启用一个 provider 后，此页会按 displayName 自动出现页签，无需改界面代码。',
            ),
          ),
          h(Notice, { notice: notice }),
        )
      }
      var tabs = list.items.map(function (item) {
        var pane = paneOf(panes, item.id)
        return h(
          'button',
          {
            key: item.id,
            type: 'button',
            role: 'tab',
            id: 'tab-' + item.id,
            className: 'bz-tab',
            'data-on': active === item.id ? 'true' : 'false',
            'data-error': pane.phase === 'error' ? 'true' : 'false',
            'aria-selected': active === item.id ? 'true' : 'false',
            'aria-controls': 'pane-' + item.id,
            tabIndex: active === item.id ? 0 : -1,
            onClick: function () {
              setActive(item.id)
              setConfirm(null)
            },
          },
          item.icon === undefined || item.icon === null
            ? null
            : h('span', { 'aria-hidden': 'true' }, item.icon),
          h('span', null, item.displayName),
          pane.phase === 'loading' ? h(Tag, { kind: 'loading' }, '加载中') : null,
          pane.phase === 'error' ? h(Tag, { kind: 'error' }, '出错') : null,
        )
      })
      var defaultHint = null
      if (
        list.defaultProvider !== null &&
        list.defaultProvider !== undefined &&
        list.activeProviders.indexOf(list.defaultProvider) === -1
      ) {
        var registered = false
        for (var j = 0; j < list.items.length; j += 1) {
          if (list.items[j].id === list.defaultProvider) registered = true
        }
        if (registered === false) {
          defaultHint = h(
            'p',
            { className: 'bz-error' },
            '默认专家库 ' +
              String(list.defaultProvider) +
              ' 未注册：已回落为首个已注册的专家库，请修正 defaultProvider。',
          )
        }
      }
      return h(
        'div',
        { className: 'bz-settings' },
        h(
          'div',
          { className: 'bz-settings__head' },
          h('h3', { className: 'bz-title' }, '专家库设置'),
        ),
        h('div', { className: 'bz-tabs', role: 'tablist', 'aria-label': '专家库页签' }, tabs),
        defaultHint,
        currentProvider === null
          ? null
          : h(SettingsPane, {
              provider: currentProvider,
              pane: currentPane,
              ui: currentUi,
              onRegion: function (value) {
                if (currentProvider === null) return
                patchUi(currentProvider.id, { region: value, regionError: false })
              },
              onLogin: function () {
                if (currentProvider === null) return
                void startLogin(currentProvider.id)
              },
              onPoll: function () {
                if (currentProvider === null || currentUi === null) return
                if (currentUi.login === null || currentUi.login === undefined) return
                void pollLogin(currentProvider.id, currentUi.login.loginId)
              },
              onCancelLogin: function () {
                if (currentProvider === null) return
                void cancelLogin(currentProvider.id)
              },
              onLogout: function (item) {
                handleLogout(item)
              },
              onClearCache: function () {
                handleClearCache()
              },
              onAuthorize: function (item) {
                if (currentProvider === null) return
                void runConnectorAction(currentProvider.id, item, 'authorize')
              },
              onRevoke: function (item) {
                if (currentProvider === null) return
                var providerId = currentProvider.id
                requestConfirm({
                  title: '清除连接器授权',
                  body: '将移除该连接器的授权记录，其工具随即不可用；需要时须重新授权。',
                  confirmLabel: '移除授权',
                  action: 'revoke',
                  run: function () {
                    return runConnectorAction(providerId, item, 'remove')
                  },
                })
              },
              onCopyConfig: function (item) {
                if (currentProvider === null) return
                void runConnectorAction(currentProvider.id, item, 'copy-config')
              },
              onRetry: function () {
                if (currentProvider === null) return
                void loadPane(currentProvider.id)
              },
              onRetryAccounts: function () {
                if (currentProvider === null) return
                void reloadAccounts(currentProvider.id)
              },
              onRetryConnectors: function () {
                if (currentProvider === null) return
                void reloadConnectors(currentProvider.id)
              },
            }),
        h(Notice, { notice: notice }),
        h(ConfirmDialog, {
          request: confirmRequest,
          onCancel: function () {
            setConfirm(null)
          },
          onConfirm: function () {
            var request = confirmRequest
            setConfirm(null)
            if (request === null || request === undefined) return
            if (typeof request.run === 'function') void request.run()
          },
        }),
      )
    }

    // ── 屏 B：会话辅助面板 ────────────────────────────────────────────────────

    var DEFAULT_FILTER = { query: '', categoryId: '', page: 1 }

    function filterOf(filters, providerId) {
      var value = filters[providerId]
      if (value === undefined) return DEFAULT_FILTER
      return {
        query: value.query === undefined ? '' : value.query,
        categoryId: value.categoryId === undefined ? '' : value.categoryId,
        page: value.page === undefined ? 1 : value.page,
      }
    }

    function ProviderSwitch(props) {
      var provider = props.provider
      var enabled = props.enabled
      var disabled = declares(provider.capabilities, 'expertMarket') !== true
      var noteId = 'switch-note-' + provider.id
      return h(
        'label',
        { className: 'bz-switch' },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          'data-switch': provider.id,
          checked: enabled === true,
          disabled: disabled,
          'aria-checked': enabled === true ? 'true' : 'false',
          'aria-label': '启用 ' + provider.displayName + ' 专家库',
          'aria-describedby': disabled === true ? noteId : null,
          onChange: function (event) {
            props.onToggle(event.target.checked)
          },
        }),
        h('span', { className: 'bz-knob', 'aria-hidden': 'true' }),
        h('b', null, provider.displayName),
        h('span', { className: 'bz-note bz-mono' }, provider.id),
        enabled === true
          ? h(Tag, { kind: 'ok' }, '已启用')
          : h(Tag, { kind: 'disabled' }, '未启用'),
        disabled === true ? h(Tag, { kind: 'disabled' }, '禁用：未声明专家市场') : null,
        disabled === true
          ? h(
              'span',
              { className: 'bz-sr', id: noteId },
              '禁用原因：该库未声明 expertMarket 能力。',
            )
          : null,
      )
    }

    /** 一条专家：当前使用 / 已选 / 应用中 / 未启用库 四态靠文字区分。 */
    function ExpertEntry(props) {
      var item = props.item
      var showPrefix = typeof item.qualifiedName === 'string' && item.qualifiedName !== item.name
      var side
      if (props.current === true) {
        side = [
          h(Tag, { key: 'cur', kind: 'readonly' }, '当前使用'),
          h(
            'button',
            { key: 'btn', type: 'button', className: 'bz-btn bz-btn--sm', disabled: true },
            '已选',
          ),
        ]
      } else if (props.busy === true) {
        side = [
          h(Tag, { key: 'applying', kind: 'loading' }, '应用中'),
          h(
            'button',
            { key: 'btn', type: 'button', className: 'bz-btn bz-btn--sm', disabled: true },
            '应用中…',
          ),
        ]
      } else if (props.disabled === true) {
        side = [
          h(Tag, { key: 'off', kind: 'disabled' }, '禁用：未选择该专家库'),
          h(
            'button',
            { key: 'btn', type: 'button', className: 'bz-btn bz-btn--sm', disabled: true },
            '选择',
          ),
        ]
      } else {
        side = [
          h(
            'button',
            {
              key: 'btn',
              type: 'button',
              className: 'bz-btn bz-btn--primary bz-btn--sm',
              'data-pick': props.providerId + ':' + item.id,
              onClick: function () {
                props.onPick()
              },
            },
            '选择',
          ),
        ]
      }
      return h(
        'div',
        { className: 'bz-entry' },
        h(
          'div',
          null,
          h(
            'div',
            { className: 'bz-entry-name' },
            showPrefix === true ? h(Tag, { kind: 'warn' }, props.providerName + ' ·') : null,
            h('span', null, item.name === undefined ? item.displayName : item.name),
            item.installed === true ? h(Tag, { kind: 'ok' }, '已安装') : null,
          ),
          h(
            'p',
            { className: 'bz-entry-desc' },
            textOf(item.description) === '' ? '（无描述）' : item.description,
          ),
        ),
        h('div', { className: 'bz-entry-side' }, side),
      )
    }

    function ExpertGroup(props) {
      var provider = props.provider
      var partition = props.partition
      var filter = props.filter
      var chips = [{ id: '', name: '全部' }].concat(props.categories)
      if (partition.phase === 'error') {
        return h(
          'section',
          { className: 'bz-group', 'data-error': 'true' },
          h(
            'div',
            { className: 'bz-group-head' },
            h(
              'span',
              { className: 'bz-gname' },
              provider.displayName,
              ' ',
              h(Tag, { kind: 'readonly' }, provider.id),
            ),
            h(Tag, { kind: 'error' }, '出错'),
          ),
          h(
            'div',
            { className: 'bz-group-body', 'data-error': 'true' },
            h('p', { className: 'bz-note' }, partition.message),
            h(
              'p',
              { className: 'bz-note' },
              '只有本分区报错：其他专家库照常显示，本分区不隐藏也不替换为空白。',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                'data-retry-group': provider.id,
                onClick: function () {
                  props.onRetry()
                },
              },
              '重试',
            ),
          ),
        )
      }
      if (partition.phase === 'loading') {
        return h(
          'section',
          { className: 'bz-group' },
          h(
            'div',
            { className: 'bz-group-head' },
            h(
              'span',
              { className: 'bz-gname' },
              provider.displayName,
              ' ',
              h(Tag, { kind: 'readonly' }, provider.id),
            ),
            h(Tag, { kind: 'loading' }, '加载中'),
          ),
          h(
            'div',
            { className: 'bz-group-body' },
            h(Skeleton, { widths: ['w80', 'w60', 'w80'] }),
            h('p', { className: 'bz-note' }, '只加载本分区；其他库的条目与状态不受影响。'),
          ),
        )
      }
      var items = Array.isArray(partition.items) ? partition.items : []
      var entries = items.map(function (item) {
        return h(ExpertEntry, {
          key: provider.id + ':' + item.id,
          item: item,
          providerId: provider.id,
          providerName: provider.displayName,
          current:
            props.currentExpert !== null &&
            props.currentExpert !== undefined &&
            props.currentExpert.id === item.id &&
            props.currentExpert.providerId === provider.id,
          busy: props.busyId === provider.id + ':' + item.id,
          disabled: props.muted === true,
          onPick: function () {
            props.onPick(item)
          },
        })
      })
      return h(
        'section',
        { className: 'bz-group', 'data-muted': props.muted === true ? 'true' : 'false' },
        h(
          'div',
          { className: 'bz-group-head' },
          h(
            'span',
            { className: 'bz-gname' },
            provider.displayName,
            ' ',
            h(Tag, { kind: 'readonly' }, provider.id),
            props.muted === true ? h(Tag, { kind: 'disabled' }, '未启用') : null,
          ),
          h(
            'span',
            { className: 'bz-note' },
            String(items.length) +
              ' / ' +
              String(partition.total === undefined ? items.length : partition.total),
          ),
        ),
        h(
          'div',
          { className: 'bz-group-body' },
          h(
            'div',
            { className: 'bz-tools' },
            h('input', {
              className: 'bz-input bz-input--grow',
              type: 'search',
              'data-search': provider.id,
              'aria-label': '搜索 ' + provider.displayName + ' 的专家',
              placeholder: '搜索专家（本库内）',
              value: filter.query,
              onChange: function (event) {
                props.onQuery(event.target.value)
              },
            }),
            searchIcon(),
          ),
          h(
            'div',
            { className: 'bz-chips', role: 'group', 'aria-label': provider.displayName + ' 分类' },
            chips.map(function (chip) {
              return h(
                'button',
                {
                  key: provider.id + ':' + (chip.id === undefined ? '' : chip.id),
                  type: 'button',
                  className: 'bz-chip',
                  'aria-pressed':
                    filter.categoryId === (chip.id === undefined ? '' : chip.id) ? 'true' : 'false',
                  'data-on':
                    filter.categoryId === (chip.id === undefined ? '' : chip.id) ? 'true' : 'false',
                  onClick: function () {
                    props.onCategory(chip.id === undefined ? '' : chip.id)
                  },
                },
                chip.name === undefined ? chip.id : chip.name,
              )
            }),
          ),
          entries.length === 0
            ? h(
                'div',
                { className: 'bz-state-block' },
                h('b', null, '本库无匹配结果'),
                h('span', { className: 'bz-tag', 'data-kind': 'empty' }, '空数据'),
                h(
                  'p',
                  { className: 'bz-note' },
                  '筛选只在 ' + provider.id + ' 分区内生效，不影响其他库。',
                ),
              )
            : entries,
        ),
      )
    }

    function SkillEntry(props) {
      var item = props.item
      var slug = textOf(
        item.slug !== undefined ? item.slug : item.id !== undefined ? item.id : item.name,
      )
      var side = []
      if (props.conflict !== null) {
        // 冲突只在一处打徽标（名称行），侧栏给禁用原因 + 禁用按钮，避免同一条目出现两个「冲突」。
        side.push(
          h(Tag, { key: 'why', kind: 'disabled' }, '禁用：已被 ' + props.conflict + ' 安装'),
        )
        side.push(
          h(
            'button',
            {
              key: 'install',
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              disabled: true,
              'aria-disabled': 'true',
              'aria-describedby': props.reasonId,
            },
            '安装',
          ),
        )
      } else if (item.installed === true) {
        side.push(h(Tag, { key: 'ok', kind: 'ok' }, '已安装'))
        side.push(h(Tag, { key: 'ro', kind: 'readonly' }, '只读'))
        side.push(
          h(
            'button',
            {
              key: 'reinstall',
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              'data-reinstall': props.providerId + ':' + slug,
              disabled: props.busy === true,
              onClick: function () {
                props.onInstall(true)
              },
            },
            props.busy === true ? '安装中…' : '重装',
          ),
        )
      } else {
        side.push(
          h(
            'button',
            {
              key: 'install',
              type: 'button',
              className: 'bz-btn bz-btn--primary bz-btn--sm',
              'data-install': props.providerId + ':' + slug,
              disabled: props.busy === true,
              onClick: function () {
                props.onInstall(false)
              },
            },
            props.busy === true ? '安装中…' : '安装',
          ),
        )
      }
      return h(
        'div',
        { className: 'bz-entry' },
        h(
          'div',
          null,
          h(
            'div',
            { className: 'bz-entry-name' },
            h('span', { className: 'bz-mono' }, slug),
            props.conflict === null ? null : h(Tag, { kind: 'danger' }, '冲突'),
            item.source === 'memoryMarket' ? h(Tag, { kind: 'readonly' }, '记忆') : null,
          ),
          h(
            'p',
            { className: 'bz-entry-desc' },
            textOf(item.description) === '' ? '（无描述）' : item.description,
          ),
          props.conflict === null
            ? null
            : h(
                'p',
                { className: 'bz-note', id: props.reasonId },
                '冲突说明：目标目录已由 ' + props.conflict + ' 安装，跨库同名不覆盖、不加后缀。',
              ),
          props.conflict === null
            ? null
            : h(
                // 用 <details> 承载「查看已有安装」：无状态、无钩子，键盘可达。
                'details',
                { className: 'bz-details' },
                h('summary', null, '查看已有安装'),
                h(
                  'p',
                  { className: 'bz-note' },
                  '已有安装：',
                  props.conflict,
                  '（providerId=',
                  h('code', null, textOf(props.conflictId)),
                  '）· 目录 ',
                  h('code', null, '.dsh/skills/' + slug + '/'),
                  '。跨库同名不覆盖：如需改用本库版本，请先移除已有安装再重试。',
                ),
              ),
        ),
        h('div', { className: 'bz-entry-side' }, side),
      )
    }

    function SkillColumn(props) {
      var provider = props.provider
      var partition = props.partition
      var head = h(
        'div',
        { className: 'bz-skillcol-head' },
        h('span', null, provider.displayName),
        h(Tag, { kind: 'readonly' }, provider.id),
        partition.phase === 'loading' ? h(Tag, { kind: 'loading' }, '加载中') : null,
        partition.phase === 'error' ? h(Tag, { kind: 'error' }, '出错') : null,
      )
      if (partition.phase === 'error') {
        return h(
          'div',
          { className: 'bz-skillcol' },
          head,
          h(
            'div',
            { className: 'bz-skillcol-body' },
            h(
              StateBlock,
              { kind: 'error', title: '技能来源读取失败' },
              h('p', { className: 'bz-note' }, partition.message),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--primary bz-btn--sm',
                  'data-retry-skills': provider.id,
                  onClick: function () {
                    props.onRetry()
                  },
                },
                '重试',
              ),
            ),
          ),
        )
      }
      var sources =
        partition.sources === undefined || partition.sources === null ? {} : partition.sources
      var skillSource =
        sources.skillMarket === undefined || sources.skillMarket === null
          ? { status: 'undeclared' }
          : sources.skillMarket
      var memorySource =
        sources.memoryMarket === undefined || sources.memoryMarket === null
          ? { status: 'undeclared' }
          : sources.memoryMarket
      var skillItems = []
      var memoryItems = []
      var items = Array.isArray(partition.items) ? partition.items : []
      for (var index = 0; index < items.length; index += 1) {
        if (items[index].source === 'memoryMarket') memoryItems.push(items[index])
        else skillItems.push(items[index])
      }
      var providerNames = props.providerNames
      var skillRows = skillItems.map(function (item) {
        var slug = textOf(item.slug !== undefined ? item.slug : item.id)
        var owner = item.installed === true ? item.installedBy : null
        var conflict = null
        if (item.installed === true && owner !== provider.id) {
          conflict =
            owner === null || owner === undefined
              ? '本机既有安装（来源未知）'
              : textOf(providerNames[owner]) === ''
                ? String(owner)
                : providerNames[owner]
        }
        return h(SkillEntry, {
          key: provider.id + ':skill:' + slug,
          item: item,
          providerId: provider.id,
          conflict: conflict,
          conflictId: owner === null || owner === undefined ? '' : String(owner),
          busy: props.busyId === provider.id + ':skill:' + slug,
          reasonId: 'conflict-' + provider.id + '-' + slug,
          onInstall: function (force) {
            props.onInstall(item, force)
          },
        })
      })
      var memoryRows = memoryItems.map(function (item) {
        var slug = textOf(item.slug !== undefined ? item.slug : item.id)
        return h(SkillEntry, {
          key: provider.id + ':memory:' + slug,
          item: item,
          providerId: provider.id,
          conflict: null,
          conflictId: '',
          busy: props.busyId === provider.id + ':memory:' + slug,
          reasonId: 'conflict-' + provider.id + '-' + slug,
          onInstall: function (force) {
            props.onInstall(item, force)
          },
        })
      })
      var skillBody
      if (skillSource.status === 'undeclared') {
        skillBody = h(
          StateBlock,
          { kind: 'empty', title: '未声明技能市场' },
          h(
            'p',
            { className: 'bz-note' },
            '该 provider 未声明 skillMarket 能力，调用该域返回 BAZAAR_CAPABILITY_UNDECLARED。',
          ),
        )
      } else if (skillSource.status === 'unavailable') {
        skillBody = h(
          StateBlock,
          { kind: 'error', title: '技能市场不可用' },
          h('p', { className: 'bz-note' }, textOf(skillSource.message)),
        )
      } else if (partition.phase === 'loading') {
        skillBody = h(
          StateBlock,
          { kind: 'loading', title: '正在搜索技能市场…' },
          h(Skeleton, { widths: ['w80', 'w60'] }),
        )
      } else if (skillRows.length === 0) {
        skillBody = h(
          StateBlock,
          { kind: 'empty', title: '技能市场没有匹配项' },
          h('p', { className: 'bz-note' }, '该库当前没有返回技能条目（空结果不是故障）。'),
        )
      } else {
        skillBody = skillRows
      }
      var memoryBody
      if (memorySource.status === 'undeclared') {
        memoryBody = h(
          'div',
          null,
          h(
            'div',
            { className: 'bz-tools' },
            h('input', {
              className: 'bz-input bz-input--grow',
              type: 'search',
              disabled: true,
              'aria-disabled': 'true',
              'aria-describedby': 'mem-why-' + provider.id,
              'aria-label': '搜索记忆（不可用）',
              placeholder: '搜索记忆（不可用）',
            }),
            h(Tag, { kind: 'disabled' }, '禁用：未声明 memoryMarket'),
          ),
          h(
            'p',
            { className: 'bz-note', id: 'mem-why-' + provider.id },
            '该 provider 未声明记忆市场能力，此处不显示条目列表，也不以「暂无条目」冒充空态。',
          ),
        )
      } else if (memorySource.available === false || memorySource.status === 'unavailable') {
        memoryBody = h(
          'div',
          null,
          h(
            'div',
            { className: 'bz-tools' },
            h('input', {
              className: 'bz-input bz-input--grow',
              type: 'search',
              disabled: true,
              'aria-disabled': 'true',
              'aria-describedby': 'mem-why-' + provider.id,
              'aria-label': '搜索记忆（不可用）',
              placeholder: '搜索记忆（不可用）',
            }),
            h(Tag, { kind: 'disabled' }, '禁用：来源不可用'),
          ),
          h(
            StateBlock,
            { kind: 'empty', title: '记忆市场不可用' },
            h(
              'p',
              { className: 'bz-note', id: 'mem-why-' + provider.id },
              textOf(memorySource.message),
            ),
          ),
        )
      } else if (memoryRows.length === 0) {
        memoryBody = h(
          StateBlock,
          { kind: 'empty', title: '记忆市场没有匹配项' },
          h('p', { className: 'bz-note' }, '该库当前没有返回记忆条目（空结果不是故障）。'),
        )
      } else {
        memoryBody = memoryRows
      }
      return h(
        'div',
        { className: 'bz-skillcol' },
        head,
        h(
          'div',
          { className: 'bz-skillcol-body' },
          h(
            'div',
            { className: 'bz-source' },
            '技能市场',
            h(Tag, { kind: 'readonly' }, '来源：skillMarket'),
          ),
          skillBody,
          h(
            'div',
            { className: 'bz-source' },
            '记忆市场',
            h(Tag, { kind: 'readonly' }, '来源：memoryMarket'),
          ),
          memoryBody,
        ),
      )
    }

    /**
     * 屏 B 容器：开关组 + 按库分组的专家 + 按库分列的两个技能来源。
     *
     * 开关组**不是**必填项：全不勾选返回合法空态，服务端也接受空数组。
     * 状态按 providerId 分键存放，单库故障只影响它自己的分区。
     */
    function SessionPanel(props) {
      var statePair = React.useState({ phase: 'loading', data: null, message: null })
      var state = statePair[0]
      var setState = statePair[1]
      var providersPair = React.useState({ phase: 'loading', items: [], message: null })
      var providers = providersPair[0]
      var setProviders = providersPair[1]
      var partsPair = React.useState({})
      var parts = partsPair[0]
      var setParts = partsPair[1]
      var skillsPair = React.useState({})
      var skills = skillsPair[0]
      var setSkills = skillsPair[1]
      var filtersPair = React.useState({})
      var filters = filtersPair[0]
      var setFilters = filtersPair[1]
      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var noticePair = React.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var reloadPair = React.useState(0)
      var reload = reloadPair[0]
      var setReload = reloadPair[1]

      var patchPart = React.useCallback(function (providerId, patch) {
        setParts(function (previous) {
          var next = Object.assign({}, previous)
          next[providerId] = Object.assign({}, previous[providerId], patch)
          return next
        })
      }, [])

      var patchSkill = React.useCallback(function (providerId, patch) {
        setSkills(function (previous) {
          var next = Object.assign({}, previous)
          next[providerId] = Object.assign({}, previous[providerId], patch)
          return next
        })
      }, [])

      var showNotice = React.useCallback(function (text, kind) {
        setNotice({ text: text, kind: kind === undefined ? 'ok' : kind })
      }, [])

      var loadExpertPartition = React.useCallback(
        async function (providerId, filter) {
          patchPart(providerId, { phase: 'loading', message: null })
          try {
            // 列表走扁平端点：那里额外补了「本机已装」标记，与技能区的安装归属同源。
            var body = await getJson(
              ROUTES.experts +
                queryOf({
                  sessionId: props.sessionId,
                  provider: providerId,
                  query: filter.query,
                  categoryId: filter.categoryId,
                  page: filter.page,
                  pageSize: 24,
                }),
            )
            var group = Array.isArray(body.groups) && body.groups.length > 0 ? body.groups[0] : null
            if (group === null) {
              patchPart(providerId, {
                phase: 'ready',
                items: [],
                total: 0,
                matchedTotal: 0,
                hasMore: false,
              })
              return
            }
            if (group.status === 'error') {
              patchPart(providerId, {
                phase: 'error',
                message: messageOf(group.message),
                code: group.code,
              })
              return
            }
            if (group.status === 'undeclared') {
              patchPart(providerId, {
                phase: 'ready',
                items: [],
                total: 0,
                matchedTotal: 0,
                hasMore: false,
                undeclared: true,
                message: messageOf(group.message),
              })
              return
            }
            patchPart(providerId, {
              phase: 'ready',
              items: Array.isArray(group.items) ? group.items : [],
              total: group.total,
              matchedTotal: group.matchedTotal,
              hasMore: group.hasMore === true,
            })
          } catch (error) {
            patchPart(providerId, { phase: 'error', message: messageOf(error), code: error.code })
          }
        },
        [patchPart, props.sessionId],
      )

      var loadSkillColumn = React.useCallback(
        async function (providerId) {
          patchSkill(providerId, { phase: 'loading', message: null })
          try {
            var body = await getJson(
              ROUTES.skillMarket +
                queryOf({
                  sessionId: props.sessionId,
                  provider: providerId,
                  page: 1,
                  pageSize: 24,
                }),
            )
            var group = Array.isArray(body.groups) && body.groups.length > 0 ? body.groups[0] : null
            if (group === null) {
              patchSkill(providerId, { phase: 'ready', items: [], sources: {} })
              return
            }
            if (group.status === 'error') {
              patchSkill(providerId, {
                phase: 'error',
                message: messageOf(group.message),
                code: group.code,
              })
              return
            }
            if (group.status === 'undeclared') {
              patchSkill(providerId, {
                phase: 'ready',
                items: [],
                sources: {
                  skillMarket: { status: 'undeclared' },
                  memoryMarket: { status: 'undeclared' },
                },
              })
              return
            }
            patchSkill(providerId, {
              phase: 'ready',
              items: Array.isArray(group.items) ? group.items : [],
              sources: group.sources === undefined || group.sources === null ? {} : group.sources,
            })
          } catch (error) {
            patchSkill(providerId, { phase: 'error', message: messageOf(error), code: error.code })
          }
        },
        [patchSkill, props.sessionId],
      )

      var loadState = React.useCallback(
        async function () {
          setState(function (previous) {
            return Object.assign({}, previous, {
              phase: previous.data === null ? 'loading' : 'refreshing',
            })
          })
          try {
            var results = await Promise.all([
              getJson(ROUTES.state + queryOf({ sessionId: props.sessionId })),
              getJson(ROUTES.providers + queryOf({ sessionId: props.sessionId })),
            ])
            var stateBody = results[0]
            var providersBody = results[1]
            var payload = stateBody.state === undefined ? stateBody : stateBody.state
            setState({ phase: 'ready', data: payload, message: null })
            setProviders({
              phase: 'ready',
              items: Array.isArray(providersBody.items) ? providersBody.items : [],
              message: null,
            })
            if (typeof props.onStateChange === 'function') props.onStateChange(payload)
          } catch (error) {
            setState({ phase: 'error', data: null, message: messageOf(error) })
            setProviders({ phase: 'error', items: [], message: messageOf(error) })
          }
        },
        [props.sessionId, props.onStateChange],
      )

      React.useEffect(
        function () {
          void loadState()
        },
        [loadState, reload],
      )

      // 数据到齐后按库各拉一次：分区互不阻塞，单库失败只红自己。
      React.useEffect(
        function () {
          if (providers.phase !== 'ready') return
          var items = providers.items
          for (var index = 0; index < items.length; index += 1) {
            var providerId = items[index].id
            if (declares(items[index].capabilities, 'expertMarket') !== true) continue
            if (parts[providerId] !== undefined) continue
            void loadExpertPartition(providerId, filterOf(filters, providerId))
          }
          for (var k = 0; k < items.length; k += 1) {
            var skillProviderId = items[k].id
            if (declares(items[k].capabilities, 'skillMarket') !== true) continue
            if (skills[skillProviderId] !== undefined) continue
            void loadSkillColumn(skillProviderId)
          }
        },
        [
          filters,
          loadExpertPartition,
          loadSkillColumn,
          parts,
          providers.phase,
          providers.items,
          skills,
        ],
      )

      var selectExpert = React.useCallback(
        async function (providerId, item) {
          setBusy({ kind: 'select', id: providerId + ':' + item.id, providerId: providerId })
          try {
            await postJson(ROUTES.select, {
              sessionId: props.sessionId,
              expertId: item.id,
              providerId: providerId,
            })
            showNotice(
              '已选择 ' +
                textOf(item.name === undefined ? item.displayName : item.name) +
                '：下一条消息生效。',
            )
            await loadState()
          } catch (error) {
            showNotice('选择失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [loadState, props.sessionId, showNotice],
      )

      var installSkill = React.useCallback(
        async function (providerId, item, force) {
          var slug = textOf(item.slug !== undefined ? item.slug : item.id)
          setBusy({ kind: 'install', id: providerId + ':skill:' + slug, providerId: providerId })
          try {
            await postJson(ROUTES.skillInstall, {
              sessionId: props.sessionId,
              providerId: providerId,
              skillId: slug,
              force: force === true,
            })
            showNotice('已安装技能 ' + slug + '。')
            await loadSkillColumn(providerId)
          } catch (error) {
            showNotice('安装失败：' + messageOf(error), 'error')
            await loadSkillColumn(providerId)
          } finally {
            setBusy(null)
          }
        },
        [loadSkillColumn, props.sessionId, showNotice],
      )

      var applyActive = React.useCallback(
        async function (nextIds) {
          try {
            await postJson(ROUTES.providersActive, {
              sessionId: props.sessionId,
              activeProviders: nextIds,
            })
            showNotice(
              nextIds.length === 0
                ? '已清空选择：全不勾选是合法空态，下次请求缺少 provider 时才会返回 BAZAAR_PROVIDER_REQUIRED。'
                : '已启用 ' + String(nextIds.length) + ' 个专家库。',
            )
            setReload(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('切换失败：' + messageOf(error), 'error')
          }
        },
        [props.sessionId, showNotice],
      )

      var enabledIds =
        state.data !== null && Array.isArray(state.data.activeProviders)
          ? state.data.activeProviders
          : []
      var providerMap = {}
      for (var providerIndex = 0; providerIndex < providers.items.length; providerIndex += 1) {
        providerMap[providers.items[providerIndex].id] = providers.items[providerIndex]
      }
      var providerNames = {}
      for (var nameIndex = 0; nameIndex < providers.items.length; nameIndex += 1) {
        providerNames[providers.items[nameIndex].id] = providers.items[nameIndex].displayName
      }
      var categories =
        state.data !== null && Array.isArray(state.data.categories) ? state.data.categories : []
      var currentExpert = state.data === null ? null : state.data.expert
      var toggles = providers.items.map(function (provider) {
        var on = enabledIds.indexOf(provider.id) !== -1
        return h(ProviderSwitch, {
          key: provider.id,
          provider: provider,
          enabled: on,
          onToggle: function (next) {
            var nextIds = enabledIds.slice()
            var at = nextIds.indexOf(provider.id)
            if (next === true && at === -1) nextIds.push(provider.id)
            if (next !== true && at !== -1) nextIds.splice(at, 1)
            void applyActive(nextIds)
          },
        })
      })
      var enabledProviders = []
      var mutedProviders = []
      for (var listIndex = 0; listIndex < providers.items.length; listIndex += 1) {
        var candidate = providers.items[listIndex]
        if (declares(candidate.capabilities, 'expertMarket') !== true) continue
        if (enabledIds.indexOf(candidate.id) === -1) mutedProviders.push(candidate)
        else enabledProviders.push(candidate)
      }
      var groups = enabledProviders.map(function (provider) {
        return h(ExpertGroup, {
          key: provider.id,
          provider: provider,
          partition:
            parts[provider.id] === undefined ? { phase: 'loading', items: [] } : parts[provider.id],
          filter: filterOf(filters, provider.id),
          categories: categories,
          currentExpert: currentExpert,
          busyId: busy === null ? null : busy.id,
          muted: false,
          onQuery: function (value) {
            setFilters(function (previous) {
              var next = Object.assign({}, previous)
              next[provider.id] = Object.assign({}, filterOf(previous, provider.id), {
                query: value,
                page: 1,
              })
              return next
            })
            stopTimer('search:' + provider.id)
            timers['search:' + provider.id] = setTimeout(function () {
              void loadExpertPartition(provider.id, {
                query: value,
                categoryId: filterOf(filters, provider.id).categoryId,
                page: 1,
              })
            }, 220)
          },
          onCategory: function (categoryId) {
            setFilters(function (previous) {
              var next = Object.assign({}, previous)
              next[provider.id] = Object.assign({}, filterOf(previous, provider.id), {
                categoryId: categoryId,
                page: 1,
              })
              return next
            })
            void loadExpertPartition(provider.id, {
              query: filterOf(filters, provider.id).query,
              categoryId: categoryId,
              page: 1,
            })
          },
          onPick: function (item) {
            void selectExpert(provider.id, item)
          },
          onRetry: function () {
            void loadExpertPartition(provider.id, filterOf(filters, provider.id))
          },
        })
      })
      // 未启用的库也列出条目，但整组禁用并写清原因：这是「未启用库的条目」那一态。
      var mutedGroups = mutedProviders.map(function (provider) {
        return h(ExpertGroup, {
          key: 'muted:' + provider.id,
          provider: provider,
          partition:
            parts[provider.id] === undefined ? { phase: 'loading', items: [] } : parts[provider.id],
          filter: filterOf(filters, provider.id),
          categories: categories,
          currentExpert: currentExpert,
          busyId: null,
          muted: true,
          onQuery: function () {},
          onCategory: function () {},
          onPick: function () {},
          onRetry: function () {
            void loadExpertPartition(provider.id, filterOf(filters, provider.id))
          },
        })
      })
      var columns = enabledProviders.map(function (provider) {
        if (declares(provider.capabilities, 'skillMarket') !== true) return null
        return h(SkillColumn, {
          key: provider.id,
          provider: provider,
          partition:
            skills[provider.id] === undefined
              ? { phase: 'loading', items: [] }
              : skills[provider.id],
          providerNames: providerNames,
          busyId: busy === null ? null : busy.id,
          onInstall: function (item, force) {
            void installSkill(provider.id, item, force)
          },
          onRetry: function () {
            void loadSkillColumn(provider.id)
          },
        })
      })

      if (state.phase === 'loading') {
        return h(
          'div',
          null,
          h(
            StateBlock,
            { kind: 'loading', title: '正在读取会话状态…' },
            h(Skeleton, { widths: ['w60', 'w80'] }),
          ),
        )
      }
      if (state.phase === 'error') {
        return h(
          'div',
          null,
          h(
            StateBlock,
            { kind: 'error', title: '会话状态读取失败' },
            h('p', { className: 'bz-note' }, state.message),
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                onClick: function () {
                  void loadState()
                },
              },
              '重试',
            ),
          ),
        )
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'bz-panel-section' },
          h('h4', null, '选择专家库（可多选）', h(Tag, { kind: 'optional' }, '可选')),
          h(
            'div',
            { className: 'bz-switches', role: 'group', 'aria-label': '选择专家库（可多选）' },
            toggles,
          ),
          h(
            'p',
            { className: 'bz-field-hint', id: 'switch-hint' },
            '本开关组不是必填项：全不勾选是合法空态，下方显示「尚未选择专家库」入口，不因此阻止浏览或搜索。真正的必填在请求层——单次选择 / 安装请求缺少 providerId 才返回 BAZAAR_PROVIDER_REQUIRED。',
          ),
        ),
        h(
          'div',
          { className: 'bz-panel-section' },
          h('h4', null, '专家', h(Tag, { kind: 'readonly' }, '按库分组')),
          enabledProviders.length === 0
            ? h(
                'div',
                { className: 'bz-empty' },
                h('h4', null, '尚未选择专家库', ' ', h(Tag, { kind: 'empty' }, '空数据')),
                h(
                  'p',
                  { className: 'bz-sub' },
                  '勾选上方任意一个专家库后，这里会按库分组并列显示专家；也可以直接选用内置的 WorkBuddy。',
                ),
                providers.items.length === 0
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'bz-btn bz-btn--primary bz-btn--sm',
                        'data-pick-default': providers.items[0].id,
                        onClick: function () {
                          void applyActive([providers.items[0].id])
                        },
                      },
                      '选择 ' + providers.items[0].displayName,
                    ),
              )
            : null,
          // 未启用的库即使在全不勾选时也照常列出（禁用态 + 原因），否则「未启用库的条目」这一态无从观察。
          groups.length > 0 || mutedGroups.length > 0
            ? h('div', { className: 'bz-groups' }, groups.concat(mutedGroups))
            : null,
        ),
        h(
          'div',
          { className: 'bz-panel-section' },
          h('h4', null, '技能', h(Tag, { kind: 'readonly' }, '每个专家库两个来源')),
          enabledProviders.length === 0
            ? h(
                StateBlock,
                { kind: 'empty', title: '未选择专家库' },
                h(
                  'p',
                  { className: 'bz-note' },
                  '技能区与专家区共用同一个活跃集；勾选专家库后按库分组显示两个来源。',
                ),
              )
            : h('div', { className: 'bz-skillwrap' }, columns),
        ),
        h(Notice, { notice: notice }),
      )
    }

    // ── 面板外壳与两条注册 ────────────────────────────────────────────────────

    /**
     * 会话面板外壳。hook 全部在顶层：`if (!props.open) return null`
     * 必须排在所有 hook 之后（`test/hook-order.test.mjs` 反向断言这一条）。
     */
    function PickerDialog(props) {
      var readyPair = React.useState(false)
      var ready = readyPair[0]
      var setReady = readyPair[1]
      var panelRef = React.useRef(null)

      React.useEffect(function () {
        setReady(true)
      }, [])

      React.useEffect(
        function () {
          function onKeyDown(event) {
            if (event.key === 'Escape' && typeof props.onClose === 'function') props.onClose()
          }
          if (typeof document === 'undefined' || document === null) return undefined
          document.addEventListener('keydown', onKeyDown)
          return function () {
            document.removeEventListener('keydown', onKeyDown)
          }
        },
        [props.onClose],
      )

      React.useEffect(
        function () {
          var node = panelRef.current
          if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
        },
        [props.open],
      )

      if (props.open !== true) return null

      var panel = h(
        'div',
        {
          className: 'bz-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '集市 · 会话辅助',
        },
        h(
          'div',
          { className: 'bz-panel-head' },
          h(
            'div',
            null,
            h('h3', { className: 'bz-title' }, '集市 · 会话辅助'),
            h(
              'p',
              { className: 'bz-sub' },
              '多上游集市：选库、选专家、装技能都在这里；账号与连接器授权在设置页。',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-iconbtn',
              'aria-label': '关闭集市面板',
              onClick: function () {
                if (typeof props.onClose === 'function') props.onClose()
              },
            },
            closeIcon(),
          ),
        ),
        h(
          'div',
          { className: 'bz-panel-body', ref: panelRef, tabIndex: -1 },
          ready === true
            ? h(SessionPanel, {
                sessionId: props.sessionId,
                onStateChange: props.onStateChange,
              })
            : null,
        ),
        h(
          'div',
          { className: 'bz-panel-foot' },
          h('span', { className: 'bz-note' }, '面板只影响当前会话；关掉它不会取消已生效的选择。'),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn',
              onClick: function () {
                if (typeof props.onClose === 'function') props.onClose()
              },
            },
            '关闭',
          ),
        ),
      )

      var scrim = h(
        'div',
        {
          className: 'bz-scrim',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget && typeof props.onClose === 'function')
              props.onClose()
          },
        },
        panel,
      )

      if (
        typeof document !== 'undefined' &&
        document !== null &&
        typeof createPortal === 'function'
      ) {
        try {
          return createPortal(scrim, document.body)
        } catch (error) {
          return scrim
        }
      }
      return scrim
    }

    /**
     * 面板崩溃兜底：宿主 SlotErrorBoundary 对非链式槽位不接管，
     * 所以这里自己接住，崩的只是面板，输入框旁边那颗按钮还在。
     */
    var DialogBoundary = (function () {
      var Base = typeof React.Component === 'function' ? React.Component : Object
      function Boundary(props) {
        if (typeof Base === 'function' && Base !== Object) {
          Base.call(this, props)
          this.state = { failed: false }
        } else {
          this.props = props
          this.state = { failed: false }
        }
      }
      Boundary.prototype = Object.create(
        Base.prototype === undefined ? Object.prototype : Base.prototype,
      )
      Boundary.prototype.constructor = Boundary
      Boundary.getDerivedStateFromError = function () {
        return { failed: true }
      }
      Boundary.prototype.componentDidCatch = function (error) {
        if (
          typeof console !== 'undefined' &&
          console !== null &&
          typeof console.error === 'function'
        ) {
          console.error(
            '[' + PACKAGE_ID + '] session dialog crashed; the composer pill stays mounted:',
            error,
          )
        }
      }
      Boundary.prototype.render = function () {
        if (this.state.failed === true) return null
        return this.props.children === undefined ? null : this.props.children
      }
      return Boundary
    })()

    function ComposerEntry(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var summaryPair = React.useState(null)
      var summary = summaryPair[0]
      var setSummary = summaryPair[1]

      React.useEffect(
        function () {
          var cancelled = false
          getJson(ROUTES.state + queryOf({ sessionId: props.sessionId }))
            .then(function (body) {
              if (cancelled === true) return
              setSummary(body.state === undefined ? body : body.state)
            })
            .catch(function () {
              if (cancelled === true) return
              setSummary(null)
            })
          return function () {
            cancelled = true
          }
        },
        [props.sessionId, open],
      )

      var expert = summary !== null && summary !== undefined ? summary.expert : null
      var label =
        expert === null || expert === undefined
          ? ''
          : textOf(expert.displayName === undefined ? expert.name : expert.displayName)
      return h(
        'div',
        { className: 'bz-host' },
        h(
          'button',
          {
            type: 'button',
            className: 'bz-pill',
            'data-active': open === true ? 'true' : 'false',
            title: label === '' ? '集市：选择专家库、专家与技能' : '集市 · 当前专家：' + label,
            onClick: function () {
              setOpen(true)
            },
          },
          h('span', { className: 'bz-pill__icon' }, personIcon()),
          h('span', null, '集市'),
          label === '' ? null : h('span', { className: 'bz-pill__name' }, label),
        ),
        open === true
          ? h(
              DialogBoundary,
              null,
              h(PickerDialog, {
                open: true,
                sessionId: props.sessionId,
                onStateChange: setSummary,
                onClose: function () {
                  setOpen(false)
                },
              }),
            )
          : null,
      )
    }

    function SettingsIcon(props) {
      var size = props.size === undefined || props.size === null ? 16 : props.size
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          'data-active': props.active === true ? 'true' : 'false',
        },
        h('path', {
          fill: 'currentColor',
          d: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h3A1.5 1.5 0 0 1 8 3.5v3A1.5 1.5 0 0 1 6.5 8h-3A1.5 1.5 0 0 1 2 6.5v-3zm6 0A1.5 1.5 0 0 1 9.5 2h3A1.5 1.5 0 0 1 14 3.5v3A1.5 1.5 0 0 1 12.5 8h-3A1.5 1.5 0 0 1 8 6.5v-3zM2 9.5A1.5 1.5 0 0 1 3.5 8h3A1.5 1.5 0 0 1 8 9.5v3A1.5 1.5 0 0 1 6.5 14h-3A1.5 1.5 0 0 1 2 12.5v-3zm6 0A1.5 1.5 0 0 1 9.5 8h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 8 12.5v-3z',
        }),
      )
    }

    function apply(ctx) {
      installStyles()
      var slots = ctx !== null && ctx !== undefined ? ctx.slots : undefined
      if (slots === undefined || slots === null) return
      try {
        slots.inject(SLOT_NAME, function () {
          return slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () {
                return '集市'
              },
            },
            ComposerEntry,
          )
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[' + PACKAGE_ID + '] composer pill registration failed:', error)
        }
      }
      // 两步分开 try/catch：设置页正文失败不该拖死图标，反之亦然。
      try {
        slots.inject(SETTINGS_SLOT, function () {
          return slots.register(
            {
              name: SETTINGS_SLOT,
              id: SETTINGS_ENTRY_ID,
              order: SETTINGS_ENTRY_ORDER,
              label: function () {
                return 'bazaar'
              },
            },
            SettingsScreen,
          )
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[' + PACKAGE_ID + '] settings section registration failed:', error)
        }
      }
      try {
        slots.inject(SETTINGS_ICON_SLOT, function () {
          return slots.register({ name: SETTINGS_ICON_SLOT, id: SETTINGS_ENTRY_ID }, SettingsIcon)
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[' + PACKAGE_ID + '] settings icon registration failed:', error)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      ROUTES,
      CSS,
      PREFIX,
      SETTINGS_ENTRY_ID,
      SETTINGS_SLOT,
      SETTINGS_ICON_SLOT,
      SLOT_NAME,
      ENTRY_ID,
      PickerDialog,
      ComposerEntry,
      SettingsScreen,
      SessionPanel,
      AccountBlock,
      CredentialBlock,
      CacheBlock,
      ConnectorBlock,
      ExpertEntry,
      SkillEntry,
      declares,
    }
    return module.exports
  },
})
