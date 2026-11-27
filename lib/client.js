/**
 * 前端两屏：设置页（屏 A）与会话集市面板（屏 B）。
 *
 * 结构按 design/index.html 的 v2.1 原型重写：
 *
 * 屏 A「集市设置」挂在 `settings.section` + `settings.section.icon` 上，顶部是一条
 * 「Provider 栏」——一个 provider 一个页签，每个页签带全局启用/禁用开关。每个页签固定
 * 四块卡片：账号与登录 / 宿主凭据 / 本地缓存 / 连接器授权。
 *
 * 屏 B 挂在 `conversation.input.left` 上，输入栏里只有三个单行胶囊：专家 / 技能 / 连接器。
 * 点开任意一个浮出「豆包风格」面板：顶部是来源过滤（只列设置页里启用的 provider）与
 * 分类标签，中间是「常用 / 推荐」两段单行列表，底部是搜索框与完整面板入口。完整面板是
 * 一个多 provider 并列的工作台（专家 / 技能与记忆 / 连接器三个域页签）。
 *
 * 五条硬约束写在这里，改代码前先读：
 *
 * 1. **单文件工厂**：本文件必须整体包在 `window.__ModuleLoader__.load({factory})` 里，
 *    不拆成多模块。宿主按工厂函数取 `apply(ctx)`，拆文件会让加载顺序不可控。
 * 2. **hook 只在函数顶层**：每个组件把 `React.use*` 全部放在函数体开头，任何
 *    `return` 都排在所有 hook 之后。面板与页签会因数据到达而重渲染，条件 hook
 *    会让 React 的 hook 顺序错位并整棵子树崩掉（宿主 SlotErrorBoundary 对非链式
 *    槽位不兜底，崩的是输入框旁边那颗按钮）。
 * 3. **状态必须有文字**：颜色只作辅助。禁用要写清「禁用：原因」，只读要写「只读」，
 *    加载中、空数据、出错三者外观必须互相可区分（`test/two-screen-e2e.test.mjs` 断言）。
 * 4. **全局禁用只在设置页拨**：会话面板不提供启用/禁用 provider 的开关，只提供「本会话
 *    选谁」。被全局禁用的库在会话面板里根本不出现（服务端 activeFor 已滤掉），因此
 *    界面不需要、也不允许再判断一次「它是不是被禁用了」。
 * 5. **颜色只消费宿主 alias 令牌**：`--dsw-alias-*` 随 `body[data-ds-dark-theme]` 翻转，
 *    插件不写自己的深色覆盖、不写 `<prefers-color-scheme>`、不碰 `--dsw-static-*`。
 *
 * 旧「军械库（armory）」桥接与四分类平铺入口已整体移除。
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
     * 三个「写」路由语义完全不同，界面必须分清：
     * - `providersActive`（POST）：本会话选了哪几家库。逐会话、可多选。
     * - `providerEnabled()`（POST）：设置页的全局开关。全机器、只有一个答案。
     * - `connectorsSession`（POST）：本会话停用了哪些连接器。
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
      update: PREFIX + '/update',
      updateAction: PREFIX + '/update/action',
      providers: PREFIX + PROVIDER_SEGMENT,
      providersActive: PREFIX + PROVIDER_SEGMENT + '/active',
      provider: function (providerId) {
        return PREFIX + PROVIDER_SEGMENT + '/' + encodeURIComponent(String(providerId))
      },
      providerStatus: function (providerId) {
        return ROUTES.provider(providerId) + '/status'
      },
      providerEnabled: function (providerId) {
        return ROUTES.provider(providerId) + '/enabled'
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
    //
    // 只消费 --dsw-alias-*，绝不消费 --dsw-static-*：宿主用 body[data-ds-dark-theme]
    // 重定义整套 alias 来翻转主题，static 令牌是「恒定色」——拿它当表面色，深色窗口里
    // 徽标、标签、禁用输入会变成一片白斑（1.0.0 的实际事故）。
    // 语义色（ok/warn/danger/info）只作为「色调来源」，用 color-mix 掺进当前底色、
    // 文字一律用 --bz-fg，于是浅色深色同时成立。
    var CSS = [
      '.bz-host,.bz-panel,.bz-settings,.bz-overlay,.bz-popover-portal,.bz-toast-float{',
      '--bz-fg:var(--dsw-alias-label-primary,#0f1115);',
      '--bz-fg-dim:var(--dsw-alias-label-secondary,#565c66);',
      '--bz-fg-mute:color-mix(in srgb,var(--bz-fg-dim) 74%,var(--bz-bg));',
      '--bz-err:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 88%,var(--dsw-alias-label-primary,#0f1115));',
      '--bz-bg:var(--dsw-alias-bg-layer-1,#fff);',
      '--bz-bg-alt:var(--dsw-alias-bg-layer-2,#f3f4f6);',
      '--bz-bg-hover:var(--dsw-alias-interactive-bg-hover,#f2f3f5);',
      '--bz-border:var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      '--bz-border-strong:var(--dsw-alias-border-l2,rgba(0,0,0,.16));',
      '--bz-mask:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.28));',
      '--bz-ok:var(--dsw-alias-state-success-primary,#22c55e);',
      '--bz-warn:var(--dsw-alias-state-warn-primary,#f59e0b);',
      '--bz-danger:var(--dsw-alias-state-error-primary,#ef4444);',
      '--bz-info:var(--dsw-alias-state-business-primary,#4166e6);',
      '--bz-ok-bg:color-mix(in srgb,var(--bz-ok) 14%,var(--bz-bg));',
      '--bz-warn-bg:color-mix(in srgb,var(--bz-warn) 14%,var(--bz-bg));',
      '--bz-danger-bg:color-mix(in srgb,var(--bz-danger) 12%,var(--bz-bg));',
      '--bz-info-bg:color-mix(in srgb,var(--bz-info) 14%,var(--bz-bg));',
      '--bz-ok-line:color-mix(in srgb,var(--bz-ok) 45%,var(--bz-bg));',
      '--bz-warn-line:color-mix(in srgb,var(--bz-warn) 45%,var(--bz-bg));',
      '--bz-danger-line:color-mix(in srgb,var(--bz-danger) 45%,var(--bz-bg));',
      '--bz-info-line:color-mix(in srgb,var(--bz-info) 45%,var(--bz-bg));',
      '--bz-sel-bg:color-mix(in srgb,var(--bz-info) 13%,var(--bz-bg));',
      '--bz-r-xs:5px;--bz-r-sm:var(--dsw-radius-sm,8px);--bz-r-md:12px;--bz-r-lg:16px;--bz-r-full:999px;',
      'color:var(--bz-fg);',
      'font-family:var(--bz-font,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);',
      'font-size:13px;line-height:1.5}',
      '.bz-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px}',
      '.bz-note{color:var(--bz-fg-dim);font-size:12px}',
      '.bz-sub{margin:4px 0 0;color:var(--bz-fg-dim);font-size:12px}',
      '.bz-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.bz-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      /* ── 输入栏：三个单行胶囊 + 崩溃安全的完整面板入口 ───────────────── */
      '.bz-host{display:inline-flex;flex-direction:row;align-items:center;gap:4px;max-width:100%;position:relative}',
      '.bz-pills-row{display:inline-flex;align-items:center;gap:4px;max-width:100%;flex-wrap:nowrap}',
      '.bz-pills{display:inline-flex;align-items:center;gap:4px;flex-wrap:nowrap}',
      '.bz-pill-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-full);background:var(--bz-bg);',
      'color:var(--bz-fg);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;flex:0 0 auto}',
      '.bz-pill-btn:hover{background:var(--bz-bg-hover)}',
      '.bz-pill-btn[data-active="true"]{border-color:var(--bz-info);background:var(--bz-sel-bg)}',
      '.bz-pill-btn[data-has-selection="true"]{border-color:var(--bz-info-line)}',
      '.bz-pill-btn__icon{display:inline-flex;width:14px;height:14px;color:var(--bz-fg-dim)}',
      '.bz-pill-btn__sub{color:var(--bz-fg-dim);font-weight:500;max-width:9em;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.bz-pill-btn__chev{display:inline-flex;width:10px;height:10px;color:var(--bz-fg-dim);opacity:.8}',
      '.bz-pill{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;width:28px;',
      'padding:0;border:1px solid var(--bz-border);border-radius:var(--bz-r-full);background:var(--bz-bg);',
      'color:var(--bz-fg-dim);cursor:pointer;flex:0 0 auto}',
      '.bz-pill:hover{background:var(--bz-bg-hover);color:var(--bz-fg)}',
      '.bz-pill[data-active="true"]{border-color:var(--bz-info);color:var(--bz-fg);background:var(--bz-sel-bg)}',
      /* ── 上浮面板（豆包风）：通过 portal 紧贴输入栏正上方 ──────────────── */
      '.bz-popover-portal{position:fixed;z-index:2010;pointer-events:auto;-webkit-app-region:no-drag}',
      '.bz-popover-wrap{position:relative;z-index:2010;-webkit-app-region:no-drag}',
      '.bz-popover{width:min(680px,calc(100vw - 24px));max-height:min(62vh,520px);display:flex;flex-direction:column;',
      'background:color-mix(in srgb,var(--bz-bg) 96%,var(--bz-bg-alt));',
      'backdrop-filter:blur(28px) saturate(1.15);-webkit-backdrop-filter:blur(28px) saturate(1.15);',
      'border:1.5px solid var(--bz-info-line);border-radius:var(--bz-r-lg);',
      'box-shadow:0 16px 40px var(--bz-mask);overflow:hidden;animation:bz-rise .14s ease-out}',
      '.bz-popover__current{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:6px 10px;border-bottom:1px solid var(--bz-border);background:var(--bz-sel-bg);font-size:12px}',
      '.bz-popover__current-main{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}',
      '.bz-popover__current-name{font-weight:600;color:var(--bz-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-popover__filters{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;',
      'padding:8px 10px;border-bottom:1px solid var(--bz-border)}',
      '.bz-filter-cluster{display:flex;flex-wrap:wrap;gap:5px;align-items:center}',
      '.bz-filter-label{font-size:11px;font-weight:600;color:var(--bz-fg-dim)}',
      '.bz-source-pill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-full);background:var(--bz-bg-alt);',
      'color:var(--bz-fg-dim);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.bz-source-pill[data-on="true"]{background:var(--bz-sel-bg);color:var(--bz-fg);border-color:var(--bz-info-line)}',
      '.bz-source-pill[data-error="true"]{border-color:var(--bz-danger-line);color:var(--bz-err)}',
      '.bz-source-dot{width:6px;height:6px;border-radius:50%;background:var(--bz-fg-mute)}',
      '.bz-source-pill[data-on="true"] .bz-source-dot{background:var(--bz-ok)}',
      '.bz-source-pill[data-error="true"] .bz-source-dot{background:var(--bz-danger)}',
      '.bz-cat-chip{height:22px;padding:0 9px;border:1px solid var(--bz-border);border-radius:var(--bz-r-full);',
      'background:var(--bz-bg-alt);color:var(--bz-fg-dim);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.bz-cat-chip[data-on="true"]{background:var(--bz-sel-bg);color:var(--bz-fg);border-color:var(--bz-fg)}',
      '.bz-popover__list{flex:1 1 auto;overflow:auto;padding:4px 6px 6px}',
      '.bz-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:7px 6px 4px;font-size:11px;font-weight:700;color:var(--bz-fg-dim);letter-spacing:.02em}',
      '.bz-doubao-row{display:flex;align-items:center;gap:8px;justify-content:space-between;',
      'padding:6px 8px;border-radius:var(--bz-r-sm);cursor:pointer}',
      '.bz-doubao-row:hover{background:var(--bz-bg-hover)}',
      '.bz-doubao-row[data-selected="true"]{background:var(--bz-sel-bg);box-shadow:inset 0 0 0 1px var(--bz-info-line)}',
      '.bz-doubao-row[data-disabled="true"]{cursor:not-allowed;opacity:.72}',
      '.bz-doubao-row__main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}',
      '.bz-doubao-row__icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;',
      'border-radius:var(--bz-r-sm);border:1px solid var(--bz-border);background:var(--bz-bg-alt);',
      'color:var(--bz-fg-dim);flex:0 0 auto}',
      '.bz-doubao-row__icon[data-tone="blue"]{border-color:var(--bz-info-line);background:var(--bz-info-bg)}',
      '.bz-doubao-row__icon[data-tone="green"]{border-color:var(--bz-ok-line);background:var(--bz-ok-bg)}',
      '.bz-doubao-row__icon[data-tone="amber"]{border-color:var(--bz-warn-line);background:var(--bz-warn-bg)}',
      '.bz-doubao-row__icon[data-tone="red"]{border-color:var(--bz-danger-line);background:var(--bz-danger-bg)}',
      '.bz-doubao-row__text{display:flex;flex-direction:row;align-items:baseline;gap:8px;min-width:0;flex:1 1 auto;overflow:hidden;line-height:1.4}',
      '.bz-doubao-row__name{display:inline-flex;align-items:center;gap:5px;flex:0 1 auto;max-width:52%;font-size:12.5px;font-weight:600;color:var(--bz-fg);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.bz-doubao-row__desc{flex:1 1 0;min-width:0;font-size:11.5px;color:var(--bz-fg-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-doubao-row__side{display:flex;align-items:center;gap:5px;flex:0 0 auto}',
      '.bz-popover__more{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 4px 2px}',
      '.bz-view-all-link{display:block;width:100%;margin:4px 0 0;padding:7px 8px;border:0;border-radius:var(--bz-r-sm);',
      'background:transparent;color:var(--bz-fg-dim);font-size:11.5px;font-weight:600;text-align:left;cursor:pointer}',
      '.bz-view-all-link:hover{background:var(--bz-bg-hover);color:var(--bz-fg)}',
      '.bz-popover__searchbar{display:flex;align-items:center;gap:8px;padding:7px 10px;',
      'border-top:1px solid var(--bz-border);background:var(--bz-bg)}',
      '.bz-popover__searchicon{display:inline-flex;color:var(--bz-fg-dim);flex:0 0 auto}',
      '.bz-popover__searchinput{flex:1 1 auto;min-width:0;height:26px;border:0;background:transparent;',
      'color:var(--bz-fg);font-size:12.5px;outline:none}',
      '.bz-popover__fullbtn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-full);background:var(--bz-bg-alt);',
      'color:var(--bz-fg-dim);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.bz-popover__fullbtn:hover{color:var(--bz-fg);border-color:var(--bz-border-strong)}',
      /* ── 空 / 加载 / 出错 ────────────────────────────────────────────── */
      '.bz-empty-box{padding:18px 14px;text-align:center;border:1px dashed var(--bz-border);',
      'border-radius:var(--bz-r-md);background:var(--bz-bg-alt);margin:8px 4px}',
      '.bz-empty-box__title{font-size:13px;font-weight:600;color:var(--bz-fg)}',
      '.bz-empty-box__desc{margin:4px 0 10px;font-size:12px;color:var(--bz-fg-dim)}',
      '.bz-inline-alert{display:flex;align-items:center;gap:8px;justify-content:space-between;',
      'margin:6px 4px;padding:7px 9px;border:1px solid var(--bz-warn-line);border-radius:var(--bz-r-sm);',
      'background:var(--bz-warn-bg);color:var(--bz-fg);font-size:12px}',
      '.bz-skel-row{display:flex;align-items:center;gap:10px;padding:8px}',
      '.bz-skel-circle{width:24px;height:24px;border-radius:50%;background:var(--bz-bg-alt);flex:0 0 auto}',
      '.bz-skel-bar{height:9px;border-radius:var(--bz-r-full);background:linear-gradient(90deg,var(--bz-bg-alt),var(--bz-bg),var(--bz-bg-alt));',
      'background-size:200% 100%;animation:bz-skel 1.2s ease-in-out infinite}',
      /* ── 完整面板（工作台）──────────────────────────────────────────── */
      '.bz-overlay{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;',
      'padding:16px;background:var(--bz-mask);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
      '-webkit-app-region:no-drag;animation:bz-fade .12s ease-out}',
      '.bz-modal{width:min(1020px,100%);max-height:min(86vh,780px);display:flex;flex-direction:column;',
      'background:color-mix(in srgb,var(--bz-bg) 96%,var(--bz-bg-alt));',
      'backdrop-filter:blur(28px) saturate(1.15);-webkit-backdrop-filter:blur(28px) saturate(1.15);',
      'border:1px solid var(--bz-border-strong);border-radius:var(--bz-r-lg);overflow:hidden;',
      'box-shadow:0 24px 64px var(--bz-mask)}',
      '.bz-modal__shell,.bz-session-root{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}',
      '.bz-modal__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;',
      'padding:12px 14px;border-bottom:1px solid var(--bz-border);flex:0 0 auto}',
      '.bz-modal__title{margin:0;font-size:15px;font-weight:600}',
      '.bz-modal__sub{margin:3px 0 0;font-size:12px;color:var(--bz-fg-dim)}',
      '.bz-modal__head-right{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.bz-modal__nav{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;',
      'padding:9px 14px;border-bottom:1px solid var(--bz-border);flex:0 0 auto}',
      '.bz-modal__toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;',
      'padding:8px 14px;border-bottom:1px solid var(--bz-border);flex:0 0 auto}',
      '.bz-modal__body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 14px}',
      '.bz-modal__foot{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'padding:9px 14px;border-top:1px solid var(--bz-border);flex:0 0 auto}',
      '.bz-icon-close{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg);',
      'color:var(--bz-fg-dim);cursor:pointer}',
      '.bz-icon-close:hover{color:var(--bz-fg);background:var(--bz-bg-hover)}',
      '.bz-domain-tabs{display:inline-flex;gap:3px;padding:3px;border:1px solid var(--bz-border);',
      'border-radius:var(--bz-r-sm);background:var(--bz-bg-alt)}',
      '.bz-domain-tab{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;',
      'border:1px solid transparent;border-radius:var(--bz-r-xs);background:transparent;',
      'color:var(--bz-fg-dim);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.bz-domain-tab[data-on="true"]{background:var(--bz-bg);color:var(--bz-fg);border-color:var(--bz-border)}',
      '.bz-provider-switches{display:flex;flex-wrap:wrap;gap:6px}',
      '.bz-switch-pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 9px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-full);background:var(--bz-bg);',
      'color:var(--bz-fg-dim);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '.bz-switch-pill[data-on="true"]{background:var(--bz-sel-bg);color:var(--bz-fg);border-color:var(--bz-info-line)}',
      '.bz-switch-track{position:relative;display:inline-block;width:24px;height:13px;border-radius:var(--bz-r-full);',
      'background:var(--bz-bg-alt);border:1px solid var(--bz-border)}',
      '.bz-switch-track::after{content:"";position:absolute;top:1px;left:1px;width:9px;height:9px;border-radius:50%;',
      'background:var(--bz-fg-mute);transition:transform .12s ease}',
      '.bz-switch-pill[data-on="true"] .bz-switch-track{background:var(--bz-ok-bg);border-color:var(--bz-ok-line)}',
      '.bz-switch-pill[data-on="true"] .bz-switch-track::after{transform:translateX(11px);background:var(--bz-fg)}',
      '.bz-search-box{display:flex;align-items:center;gap:7px;flex:1 1 240px;height:28px;padding:0 9px;',
      'border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg)}',
      '.bz-search-box input{flex:1 1 auto;min-width:0;border:0;background:transparent;color:var(--bz-fg);',
      'font-size:12.5px;outline:none}',
      '.bz-lib-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}',
      '.bz-lib-card{border:1px solid var(--bz-border);border-radius:var(--bz-r-md);background:var(--bz-bg);',
      'overflow:hidden;display:flex;flex-direction:column}',
      '.bz-lib-card[data-muted="true"]{background:var(--bz-bg-alt)}',
      '.bz-lib-card[data-error="true"]{border-color:var(--bz-danger-line)}',
      '.bz-lib-card__head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:8px 10px;border-bottom:1px solid var(--bz-border)}',
      '.bz-lib-card__name{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;min-width:0}',
      '.bz-lib-card__body{padding:8px 10px;overflow:auto;max-height:46vh}',
      '.bz-subhead{display:flex;align-items:center;gap:6px;margin:8px 0 4px;font-size:11.5px;',
      'font-weight:700;color:var(--bz-fg-dim)}',
      '.bz-subhead:first-child{margin-top:0}',
      '.bz-workbench-item{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;',
      'padding:7px 0;border-top:1px solid var(--bz-border)}',
      '.bz-workbench-item:first-of-type{border-top:0}',
      '.bz-workbench-item[data-selected="true"] .bz-workbench-item__title{color:var(--bz-ok-fg,var(--bz-fg))}',
      '.bz-workbench-item__main{min-width:0}',
      '.bz-workbench-item__title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;font-weight:600}',
      '.bz-workbench-item__desc{margin:2px 0 0;font-size:11.5px;color:var(--bz-fg-dim)}',
      '.bz-workbench-item__side{display:flex;flex-wrap:wrap;align-items:center;gap:6px;justify-content:flex-end;flex:0 0 auto}',
      '.bz-conflict-details{margin:4px 0 0}',
      '.bz-conflict-details>summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--bz-fg-dim);list-style:none}',
      '.bz-conflict-details>summary::-webkit-details-marker{display:none}',
      '.bz-conflict-details>summary::before{content:"\\25B8 ";font-size:10px}',
      '.bz-conflict-details[open]>summary::before{content:"\\25BE "}',
      /* ── 徽标 / 按钮 / 表单（语义色只作为色调）────────────────────────── */
      '.bz-tag{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:var(--bz-r-full);',
      'font-size:11px;font-weight:600;line-height:1.65;border:1px solid transparent;white-space:nowrap;color:var(--bz-fg)}',
      '.bz-tag[data-kind="ok"]{background:var(--bz-ok-bg);border-color:var(--bz-ok-line)}',
      '.bz-tag[data-kind="warn"]{background:var(--bz-warn-bg);border-color:var(--bz-warn-line)}',
      '.bz-tag[data-kind="error"]{background:var(--bz-danger-bg);border-color:var(--bz-danger-line);color:var(--bz-err)}',
      '.bz-tag[data-kind="danger"]{background:var(--bz-danger-bg);border-color:var(--bz-danger-line)}',
      '.bz-tag[data-kind="info"]{background:var(--bz-info-bg);border-color:var(--bz-info-line)}',
      '.bz-tag[data-kind="muted"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim);border-color:var(--bz-border)}',
      '.bz-tag[data-kind="empty"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim)}',
      '.bz-tag[data-kind="disabled"]{background:var(--bz-bg-alt);color:var(--bz-fg-mute);border-color:var(--bz-border)}',
      '.bz-tag[data-kind="readonly"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim)}',
      '.bz-tag[data-kind="req"]{background:var(--bz-danger-bg);border-color:var(--bz-danger-line)}',
      '.bz-tag[data-kind="loading"]{background:var(--bz-info-bg);border-color:var(--bz-info-line)}',
      '.bz-tag[data-kind="optional"]{background:var(--bz-bg-alt);color:var(--bz-fg-dim)}',
      '.bz-btn{height:28px;padding:0 11px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);',
      'background:var(--bz-bg);color:var(--bz-fg);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}',
      '.bz-btn:hover:not(:disabled){border-color:var(--bz-border-strong);background:var(--bz-bg-hover)}',
      // 主按钮直接引用宿主的 label-primary / bg-layer-2 两个别名令牌，不走会翻转的 brand 令牌：
      // 品牌色在深浅主题下自己翻转，做按钮底色会出现「浅色主题白字白底」。视觉上与
      // --bz-btn-primary-bg / --bz-btn-primary-fg 等价，写别名是为了让令牌来源可静态核对。
      '.bz-btn--primary{background:var(--dsw-alias-label-primary,#0f1115);',
      'border-color:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-2,#fff)}',
      '.bz-btn--primary:hover:not(:disabled){background:var(--dsw-alias-label-primary,#0f1115);',
      'border-color:var(--dsw-alias-label-primary,#0f1115);opacity:.9}',
      '.bz-btn--accent{background:var(--bz-info-bg);border-color:var(--bz-info-line);color:var(--bz-fg)}',
      '.bz-btn--danger{background:var(--bz-danger-bg);border-color:var(--bz-danger-line);color:var(--bz-fg)}',
      '.bz-btn--ghost{background:transparent;border-color:transparent;color:var(--bz-fg-dim)}',
      '.bz-btn--quiet{background:transparent;border-color:transparent;color:var(--bz-fg-dim)}',
      '.bz-btn--sm{height:24px;padding:0 9px;font-size:11.5px}',
      '.bz-btn:disabled{cursor:not-allowed;opacity:.55}',
      '.bz-field{margin:0 0 10px}',
      '.bz-field--invalid{padding-left:8px;border-left:3px solid var(--bz-err)}',
      '.bz-field-label{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;font-weight:500;color:var(--bz-fg-dim)}',
      '.bz-field-value{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:4px}',
      '.bz-field-hint{margin:4px 0 0;font-size:12px;color:var(--bz-fg-dim)}',
      '.bz-field-hint--error{color:var(--bz-err)}',
      '.bz-val{display:inline-block}',
      '.bz-mask{letter-spacing:.06em}',
      '.bz-input,.bz-select{height:28px;padding:0 8px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);',
      'background:var(--bz-bg);color:var(--bz-fg);font-size:13px;min-width:0}',
      '.bz-input--grow{flex:1 1 220px}',
      '.bz-input:disabled,.bz-select:disabled{cursor:not-allowed;color:var(--bz-fg-mute);background:var(--bz-bg-alt)}',
      '.bz-input[aria-invalid="true"],.bz-select[aria-invalid="true"]{border-color:var(--bz-err)}',
      '.bz-select{min-width:220px}',
      '.bz-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px}',
      '.bz-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}',
      '.bz-chip{height:24px;padding:0 10px;border:1px solid var(--bz-border);border-radius:var(--bz-r-full);',
      'background:var(--bz-bg-alt);color:var(--bz-fg-dim);font-size:11px;font-weight:600;cursor:pointer}',
      '.bz-chip[data-on="true"]{background:var(--bz-sel-bg);color:var(--bz-fg);border-color:var(--bz-fg)}',
      '.bz-active{padding:10px 12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg-alt)}',
      '.bz-details{margin:4px 0 0}',
      '.bz-details>summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--bz-fg-dim);list-style:none}',
      '.bz-details>summary::-webkit-details-marker{display:none}',
      '.bz-state-block{padding:10px 12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-sm);background:var(--bz-bg-alt)}',
      '.bz-state-block--error{border-color:var(--bz-danger-line);background:var(--bz-danger-bg);color:var(--bz-fg)}',
      '.bz-state-block--loading{background:var(--bz-bg-alt)}',
      '.bz-state-block b{font-size:13px;font-weight:600}',
      '.bz-skel{height:9px;margin:8px 0 0;border-radius:var(--bz-r-full);',
      'background:linear-gradient(90deg,var(--bz-bg-alt),var(--bz-bg),var(--bz-bg-alt));',
      'background-size:200% 100%;animation:bz-skel 1.2s ease-in-out infinite}',
      '.bz-skel--w40{width:40%}.bz-skel--w60{width:60%}.bz-skel--w80{width:80%}',
      /* ── 设置页（屏 A）──────────────────────────────────────────────── */
      '.bz-settings{max-width:1080px;margin:0 auto;padding:0}',
      '.bz-settings__head{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;justify-content:space-between}',
      '.bz-settings__meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--bz-fg-dim);font-size:12px}',
      '.bz-title{margin:0;font-size:16px;font-weight:600;line-height:1.35}',
      '.bz-tabs{display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;margin:10px 0;padding-bottom:2px}',
      '.bz-tab{display:inline-flex;gap:6px;align-items:center;height:28px;padding:0 10px;border:1px solid var(--bz-border);',
      'border-radius:var(--bz-r-full);background:var(--bz-bg-alt);color:var(--bz-fg-dim);font-size:12px;',
      'font-weight:500;cursor:pointer;white-space:nowrap}',
      '.bz-tab[data-on="true"]{background:var(--bz-sel-bg);color:var(--bz-fg);border-color:var(--bz-fg)}',
      '.bz-tab[data-error="true"]{color:var(--bz-err);border-color:var(--bz-danger-line)}',
      '.bz-banner{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;',
      'padding:10px 12px;margin:0 0 12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-md);',
      'background:var(--bz-bg-alt)}',
      '.bz-banner[data-enabled="true"]{border-color:var(--bz-ok-line);background:var(--bz-ok-bg)}',
      '.bz-banner__meta{min-width:0}',
      '.bz-banner__title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;font-weight:600}',
      '.bz-banner__desc{margin:3px 0 0;font-size:12px;color:var(--bz-fg-dim)}',
      '.bz-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}',
      '.bz-cards[data-muted="true"]{opacity:.86}',
      '.bz-card{display:flex;flex-direction:column;gap:6px;padding:11px 12px;border:1px solid var(--bz-border);',
      'border-radius:var(--bz-r-md);background:var(--bz-bg)}',
      '.bz-card__head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.bz-card__title{margin:0;font-size:13px;font-weight:600}',
      '.bz-list{list-style:none;margin:0;padding:0}',
      '.bz-list>li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;',
      'padding:7px 0;border-top:1px solid var(--bz-border)}',
      '.bz-list>li:first-child{border-top:0}',
      '.bz-empty{padding:14px;border:1px dashed var(--bz-border);border-radius:var(--bz-r-md);background:var(--bz-bg-alt)}',
      '.bz-empty h4{margin:0 0 6px;font-size:14px;font-weight:600;display:flex;gap:8px;align-items:center}',
      '.bz-update{margin-top:14px;padding:12px;border:1px solid var(--bz-border);border-radius:var(--bz-r-md);background:var(--bz-bg-alt)}',
      '.bz-update__title{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--bz-fg-dim)}',
      '.bz-update__card{margin-top:8px;padding:10px;border:1px solid var(--bz-info-line);border-radius:var(--bz-r-sm);background:var(--bz-bg)}',
      '.bz-update__confirm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      '.bz-error{margin:6px 0 0;color:var(--bz-err);font-size:12px}',
      '.bz-link{border:0;background:none;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font-size:12px}',
      /* 二次确认：危险操作 */
      '.bz-confirm{position:fixed;inset:0;z-index:2020;display:flex;align-items:center;justify-content:center;',
      'background:var(--bz-mask);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
      '-webkit-app-region:no-drag;animation:bz-fade .12s ease-out}',
      '.bz-confirm__box{width:min(460px,calc(100vw - 32px));background:color-mix(in srgb,var(--bz-bg) 96%,var(--bz-bg-alt));',
      'backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid var(--bz-border-strong);',
      'border-radius:var(--bz-r-md);padding:16px}',
      '.bz-confirm__title{margin:0 0 8px;font-size:14px;font-weight:600}',
      '.bz-confirm__body{margin:0;font-size:13px}',
      '.bz-confirm__actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}',
      '.bz-toast{flex:0 0 auto;margin:6px 12px 8px;padding:7px 10px;border-radius:var(--bz-r-sm);',
      'background:var(--bz-bg-alt);border:1px solid var(--bz-border);font-size:12px}',
      '.bz-toast[data-kind="error"]{background:var(--bz-danger-bg);border-color:var(--bz-danger-line);color:var(--bz-fg)}',
      '.bz-toast-float{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2015;',
      'max-width:min(520px,calc(100vw - 32px));pointer-events:none;box-shadow:0 8px 24px var(--bz-mask);',
      'backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:var(--bz-r-sm)}',
      '.bz-toast-float>.bz-toast{margin:0}',
      '@keyframes bz-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes bz-rise{from{transform:translateY(6px);opacity:0}to{transform:translateY(0);opacity:1}}',
      '@keyframes bz-skel{0%{background-position:0 0}100%{background-position:-200% 0}}',
      '@media (max-width:720px){.bz-popover{width:calc(100vw - 16px)}.bz-modal{max-height:92vh}}',
      '@media (max-width:640px){.bz-lib-grid,.bz-cards{grid-template-columns:1fr}}',
      '@media (prefers-reduced-motion:reduce){.bz-popover,.bz-overlay,.bz-confirm,.bz-skel{animation:none}}',
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

    // ── 最近使用：「常用」分区的唯一数据源 ────────────────────────────────────
    // 后端没有「最近使用」接口，这里在浏览器本地记一份，按分类各留 5 条。
    // 没有 localStorage（含 node 测试夹具）时退回进程内对象，功能不降级。
    var RECENT_KEY = PACKAGE_ID + '-recent'
    var RECENT_LIMIT = 5
    var RECENT_KINDS = [
      { id: 'expert', label: '专家' },
      { id: 'skill', label: '技能' },
      { id: 'connector', label: '连接器' },
    ]
    var recentMemory = null

    function emptyRecent() {
      return { expert: [], skill: [], connector: [] }
    }

    function loadRecent() {
      if (recentMemory !== null) return recentMemory
      var result = emptyRecent()
      try {
        var raw =
          typeof window !== 'undefined' && window !== null && window.localStorage !== undefined
            ? window.localStorage.getItem(RECENT_KEY)
            : null
        if (typeof raw === 'string' && raw !== '') {
          var parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') {
            for (var index = 0; index < RECENT_KINDS.length; index += 1) {
              var kind = RECENT_KINDS[index].id
              if (Array.isArray(parsed[kind])) result[kind] = parsed[kind].slice(0, RECENT_LIMIT)
            }
          }
        }
      } catch (error) {
        void error
      }
      recentMemory = result
      return result
    }

    function saveRecent(store) {
      recentMemory = store
      try {
        if (typeof window !== 'undefined' && window !== null && window.localStorage !== undefined) {
          window.localStorage.setItem(RECENT_KEY, JSON.stringify(store))
        }
      } catch (error) {
        void error
      }
    }

    function rememberRecent(kind, item) {
      var store = loadRecent()
      var id = textOf(item.id === undefined ? item.slug : item.id)
      if (id === '') return
      var list = Array.isArray(store[kind]) ? store[kind].slice() : []
      list = list.filter(function (entry) {
        return textOf(entry.id) !== id || textOf(entry.providerId) !== textOf(item.providerId)
      })
      list.unshift({
        id: id,
        name: textOf(item.name === undefined ? item.displayName : item.name),
        providerId: textOf(item.providerId),
        description: textOf(item.description).slice(0, 120),
      })
      store[kind] = list.slice(0, RECENT_LIMIT)
      saveRecent(store)
    }

    function recentOf(kind) {
      var store = loadRecent()
      var list = store[kind]
      return Array.isArray(list) ? list.slice(0, RECENT_LIMIT) : []
    }

    function kindLabel(kind) {
      for (var index = 0; index < RECENT_KINDS.length; index += 1) {
        if (RECENT_KINDS[index].id === kind) return RECENT_KINDS[index].label
      }
      return kind
    }

    /** 条目稳定键：同一 id 在不同 provider 下是两条，必须双键。 */
    function itemKey(providerId, id) {
      return textOf(providerId) + ':' + textOf(id)
    }

    /** 判定某专家行是否为当前已选专家（兼容门户 expert_id 与本地已装 plugin slug）。 */
    function isExpertSelected(currentExpert, row) {
      if (
        currentExpert === null ||
        currentExpert === undefined ||
        row === null ||
        row === undefined
      ) {
        return false
      }
      var curProvider = textOf(currentExpert.providerId)
      if (curProvider !== '' && curProvider !== textOf(row.providerId)) return false
      var curId = textOf(currentExpert.id)
      var rowId = textOf(row.id)
      if (curId !== '' && curId === rowId) return true
      var curPlugin = textOf(currentExpert.plugin)
      var rowPlugin = row.raw !== null && row.raw !== undefined ? textOf(row.raw.plugin) : ''
      if (
        curPlugin !== '' &&
        (curPlugin === rowId || (rowPlugin !== '' && curPlugin === rowPlugin))
      ) {
        return true
      }
      return false
    }

    function recentKeysOf(kind) {
      var rows = recentOf(kind)
      var keys = []
      for (var index = 0; index < rows.length; index += 1) {
        keys.push(itemKey(rows[index].providerId, rows[index].id))
      }
      return keys
    }

    // ── 图标 ──────────────────────────────────────────────────────────────────

    function svg(paths, size) {
      var box = size === undefined ? 14 : size
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: box,
          height: box,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths,
      )
    }

    function strokePath(d, extra) {
      var attrs = {
        d: d,
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }
      var keys = Object.keys(extra === undefined ? {} : extra)
      for (var index = 0; index < keys.length; index += 1) attrs[keys[index]] = extra[keys[index]]
      return h('path', attrs)
    }

    function personIcon(size) {
      return svg(
        [
          strokePath('M8 7.6a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z'),
          strokePath('M3.2 13.6a4.8 4.8 0 0 1 9.6 0'),
        ],
        size,
      )
    }

    function boltIcon(size) {
      return svg([strokePath('M8.6 1.8 4 8.6h3.6L7 14.2l5.4-7H8.9l-.3-5.4Z')], size)
    }

    function plugIcon(size) {
      return svg(
        [
          strokePath(
            'M6 2.2v3M10 2.2v3M4 5h8v2.8A3.8 3.8 0 0 1 8.2 11.6h-.4A3.8 3.8 0 0 1 4 7.8V5Z',
          ),
          strokePath('M8 11.6v2.2'),
        ],
        size,
      )
    }

    function memoryIcon(size) {
      return svg(
        [
          h('circle', { cx: 8, cy: 8, r: 5.6, stroke: 'currentColor', 'stroke-width': 1.35 }),
          strokePath('M8 4.8v3.4l2.2 1.4'),
        ],
        size,
      )
    }

    function searchIcon(size) {
      return svg(
        [
          h('circle', { cx: 7, cy: 7, r: 4.4, stroke: 'currentColor', 'stroke-width': 1.4 }),
          strokePath('M10.4 10.4l3.2 3.2'),
        ],
        size,
      )
    }

    function closeIcon(size) {
      return svg([strokePath('M4 4l8 8M12 4l-8 8', { 'stroke-width': 1.7 })], size)
    }

    function chevronIcon(size) {
      return svg([strokePath('M6.4 3.6 10.4 8l-4 4.4', { 'stroke-width': 1.8 })], size)
    }

    function gridIcon(size) {
      return svg(
        [
          h('rect', {
            x: 2.4,
            y: 2.4,
            width: 4.6,
            height: 4.6,
            rx: 1.2,
            stroke: 'currentColor',
            'stroke-width': 1.35,
          }),
          h('rect', {
            x: 9,
            y: 2.4,
            width: 4.6,
            height: 4.6,
            rx: 1.2,
            stroke: 'currentColor',
            'stroke-width': 1.35,
          }),
          h('rect', {
            x: 2.4,
            y: 9,
            width: 4.6,
            height: 4.6,
            rx: 1.2,
            stroke: 'currentColor',
            'stroke-width': 1.35,
          }),
          h('rect', {
            x: 9,
            y: 9,
            width: 4.6,
            height: 4.6,
            rx: 1.2,
            stroke: 'currentColor',
            'stroke-width': 1.35,
          }),
        ],
        size,
      )
    }

    function kindIcon(kind, size) {
      if (kind === 'expert') return personIcon(size)
      if (kind === 'skill') return boltIcon(size)
      if (kind === 'connector') return plugIcon(size)
      return memoryIcon(size)
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

    // ── 能力域判定（契约字段的唯一解读点）────────────────────────────────────
    var CAPABILITY_KEYS = [
      'expertMarket',
      'skillMarket',
      'memoryMarket',
      'connectorMarket',
      'account',
    ]

    function declares(capabilities, domain) {
      return (
        capabilities !== null && typeof capabilities === 'object' && capabilities[domain] === true
      )
    }

    function declaredList(capabilities) {
      var names = []
      for (var index = 0; index < CAPABILITY_KEYS.length; index += 1) {
        if (declares(capabilities, CAPABILITY_KEYS[index]) === true)
          names.push(CAPABILITY_KEYS[index])
      }
      return names.length === 0 ? '（无）' : names.join(' / ')
    }

    var LOGIN_REGIONS = [
      { value: 'cn', label: '国内版（codebuddy.cn 账号体系）' },
      { value: 'global', label: '国际版（workbuddy.ai 账号体系）' },
    ]

    var REGION_REQUIRED = '请先选择登录区域（国内版 / 国际版）'

    // ── 屏 A：设置页 ──────────────────────────────────────────────────────────

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
      if (accounts === null || accounts.phase === 'loading') {
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
        var account = items[0]
        rows.push(
          h(
            Field,
            {
              key: 'logged',
              label: '登录状态',
              hint:
                items.length > 1
                  ? '共检测到 ' + String(items.length) + ' 个账号（优先按对应区域匹配市场域名）。'
                  : '账号标识脱敏展示，不可编辑；切换账号请先退出。',
            },
            h(Tag, { kind: 'ok' }, '已登录'),
            h(
              'span',
              { className: 'bz-val bz-mono' },
              account.nickname || account.accountId || '（未命名账号）',
            ),
            h(Tag, { kind: 'readonly' }, '只读'),
          ),
          h(
            Field,
            { key: 'region', label: '区域 / 到期' },
            h(
              'span',
              { className: 'bz-val bz-mono' },
              account.region === 'global' ? '国际版' : '国内版',
            ),
            h(
              'span',
              { className: 'bz-val bz-mono' },
              account.expired === true
                ? 'access token 已过期'
                : '到期 ' + fmtTime(account.expiresAt),
            ),
            account.source === 'vault' ? h(Tag, { kind: 'muted' }, '共享凭据库') : null,
          ),
          items.length > 1
            ? h(
                Field,
                { key: 'more-accounts', label: '全部已发现账号' },
                h(
                  'div',
                  { className: 'bz-row' },
                  items.map(function (entry) {
                    return h(
                      Tag,
                      {
                        key: entry.accountId + '-' + entry.region,
                        kind: entry.expired ? 'warn' : 'muted',
                      },
                      (entry.nickname || entry.accountId) +
                        '（' +
                        (entry.region === 'global' ? '国际版' : '国内版') +
                        '）',
                    )
                  }),
                ),
              )
            : null,
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
                  props.onLogout(account)
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
            hint: '该市场的专家 / 技能仅对已登录账号开放；请先完成 token 认证。',
          },
          h(Tag, { kind: 'empty' }, '未登录'),
        ),
      )
      if (login !== undefined && login !== null && login.loginId !== undefined) {
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
                onClick: function () {
                  props.onLogin()
                },
              },
              ui.busy === 'login' ? '登录中…' : '登录',
            ),
            configured === true ? null : h(Tag, { kind: 'disabled' }, '禁用：凭据未配置'),
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
            label: '凭证引用名',
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
                ? '清理会删除该库的缓存目录，下次取数需重新拉取；需二次确认。'
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
              onClick: function () {
                props.onClearCache()
              },
            },
            '清理缓存',
          ),
          h(Tag, { kind: 'danger' }, '危险'),
          hasCache === true ? null : h(Tag, { kind: 'disabled' }, '禁用：当前无缓存'),
        ),
      )
    }

    function ConnectorBlock(props) {
      var provider = props.provider
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
      var inactive = props.disabled === true
      if (items.length === 0) {
        return h(
          StateBlock,
          { kind: 'empty', title: '没有可用连接器' },
          h('p', { className: 'bz-note' }, '该 provider 当前没有返回连接器条目。'),
        )
      }
      var visibleItems = items.length > 16 ? items.slice(0, 16) : items
      var rows = visibleItems.map(function (item) {
        var state = item.state === undefined || item.state === null ? {} : item.state
        var connecting = state.connecting === true
        var authorized =
          state.connected === true || item.connected === true || item.authorized === true
        var catalogOnly = item.catalogOnly === true && authorized !== true
        var toolCount = Array.isArray(item.tools)
          ? item.tools.length
          : Number(item.tools === undefined ? 0 : item.tools) || 0
        var reason = state.reason === undefined || state.reason === null ? null : state.reason
        var stateTag = connecting
          ? h(Tag, { kind: 'loading' }, '授权中')
          : authorized
            ? h(Tag, { kind: 'ok' }, '已连接')
            : catalogOnly
              ? h(Tag, { kind: 'muted' }, '目录只读')
              : h(Tag, { kind: 'warn' }, '需授权')
        var actions = []
        if (catalogOnly === true) {
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
        } else if (authorized === true) {
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
          h(
            'div',
            null,
            h(
              'div',
              { className: 'bz-row' },
              h(
                'span',
                { className: 'bz-val bz-mono' },
                item.name === undefined ? item.id : item.name,
              ),
              h(
                'span',
                { className: 'bz-note' },
                textOf(item.transport) === ''
                  ? 'transport 未知'
                  : item.transport + ' · ' + String(toolCount) + ' 个工具',
              ),
              stateTag,
              inactive === true ? h(Tag, { kind: 'disabled' }, '该 Provider 已禁用') : null,
            ),
            reason === null ? null : h('p', { className: 'bz-note' }, textOf(reason.message)),
          ),
          h('div', { className: 'bz-workbench-item__side' }, actions),
        )
      })
      return h(
        'div',
        null,
        h('ul', { className: 'bz-list' }, rows),
        items.length > visibleItems.length
          ? h(
              'p',
              { className: 'bz-field-hint' },
              '仅展示前 ' +
                String(visibleItems.length) +
                ' 项（共 ' +
                String(items.length) +
                ' 项），更多连接器可在会话面板搜索查看。',
            )
          : null,
        h(
          'p',
          { className: 'bz-field-hint' },
          inactive === true
            ? '禁用原因：该 Provider 已在上方全局禁用，重新启用后可操作。'
            : '只提供列表 / 筛选 / 详情 / OAuth 授权 / 复制配置片段；写入宿主配置并重载不由本页承担。',
        ),
      )
    }

    function SettingsPane(props) {
      var provider = props.provider
      var pane = props.pane
      var muted = props.muted === true
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
            h('p', { className: 'bz-note' }, '只加载当前页签的内容；其他页签的加载状态不受影响。'),
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
        muted === true
          ? h(
              'p',
              { className: 'bz-note' },
              '该 Provider 已在设置页全局禁用：以下内容仍可查看，但它的专家、技能与连接器不会出现在会话面板与完整面板里。重新启用后恢复。',
            )
          : null,
        h(
          'div',
          { className: 'bz-cards', 'data-muted': muted === true ? 'true' : 'false' },
          h(
            'article',
            { className: 'bz-card' },
            h(
              'div',
              { className: 'bz-card__head' },
              h('h4', { className: 'bz-card__title' }, '账号与登录'),
              h(Tag, { kind: 'muted' }, provider.id),
            ),
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
          ),
          h(
            'article',
            { className: 'bz-card' },
            h(
              'div',
              { className: 'bz-card__head' },
              h('h4', { className: 'bz-card__title' }, '宿主凭据'),
              h(
                Tag,
                {
                  kind:
                    pane.status === null
                      ? 'muted'
                      : pane.status.credential.configured === true
                        ? 'ok'
                        : 'error',
                },
                pane.status === null
                  ? '读取中'
                  : pane.status.credential.configured === true
                    ? '已配置'
                    : '未配置',
              ),
            ),
            h(CredentialBlock, { provider: provider, status: pane.status }),
          ),
          h(
            'article',
            { className: 'bz-card' },
            h(
              'div',
              { className: 'bz-card__head' },
              h('h4', { className: 'bz-card__title' }, '本地缓存'),
              h(
                'span',
                { className: 'bz-mono bz-note' },
                pane.status === null
                  ? '统计中'
                  : fmtBytes(pane.status.cache.bytes) +
                      ' · ' +
                      String(
                        pane.status.cache.entries === undefined ? 0 : pane.status.cache.entries,
                      ) +
                      ' 条',
              ),
            ),
            h(CacheBlock, {
              provider: provider,
              status: pane.status,
              onClearCache: props.onClearCache,
            }),
          ),
          h(
            'article',
            { className: 'bz-card' },
            h(
              'div',
              { className: 'bz-card__head' },
              h('h4', { className: 'bz-card__title' }, '连接器授权'),
              h(
                Tag,
                { kind: 'muted' },
                String(
                  pane.connectors === null || Array.isArray(pane.connectors.items) !== true
                    ? 0
                    : pane.connectors.items.length,
                ) + ' 项',
              ),
            ),
            h(ConnectorBlock, {
              provider: provider,
              status: pane.status,
              connectors: pane.connectors,
              disabled: muted,
              onAuthorize: props.onAuthorize,
              onRevoke: props.onRevoke,
              onCopyConfig: props.onCopyConfig,
              onRetry: props.onRetryConnectors,
            }),
          ),
        ),
      )
    }

    /**
     * 设置页的「版本与更新」区块：进入页面即查 GitHub latest Release，
     * 有新版本显示卡片与「立即更新」按钮（危险操作，走二次确认）。
     * 检查只读、安装才写；两者状态分开，检查失败不该把整页拖进错误态。
     */
    function VersionUpdateBlock(props) {
      var infoPair = React.useState({ phase: 'loading', data: null, message: null })
      var info = infoPair[0]
      var setInfo = infoPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var confirmPair = React.useState(false)
      var confirm = confirmPair[0]
      var setConfirm = confirmPair[1]

      var loadUpdate = React.useCallback(async function () {
        setInfo({ phase: 'loading', data: null, message: null })
        try {
          var body = await getJson(ROUTES.update)
          setInfo({
            phase: 'ready',
            data: body.update === undefined || body.update === null ? {} : body.update,
            message: typeof body.error === 'string' ? body.error : null,
          })
        } catch (error) {
          setInfo({ phase: 'error', data: null, message: messageOf(error) })
        }
      }, [])

      React.useEffect(
        function () {
          void loadUpdate()
        },
        [loadUpdate],
      )

      var data = info.data === null ? {} : info.data
      var available = data.updateAvailable === true
      return h(
        'section',
        { className: 'bz-update', 'aria-label': '版本与更新' },
        h('h3', { className: 'bz-update__title' }, '版本与更新'),
        info.phase === 'loading'
          ? h(
              StateBlock,
              { kind: 'loading', title: '正在检查最新版本…' },
              h(Skeleton, { widths: ['w60'] }),
            )
          : null,
        info.phase === 'error'
          ? h(
              StateBlock,
              { kind: 'error', title: '版本检查失败' },
              h('p', { className: 'bz-note' }, info.message),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--sm',
                  onClick: function () {
                    void loadUpdate()
                  },
                },
                '重试',
              ),
            )
          : null,
        info.phase === 'ready'
          ? h(
              'div',
              null,
              h(
                'p',
                { className: 'bz-note', role: 'status' },
                '当前版本 v' +
                  String(data.currentVersion === undefined ? '未知' : data.currentVersion) +
                  '；最新版本 ' +
                  (data.latestVersion ? 'v' + data.latestVersion : '未知') +
                  '。',
              ),
              data.message !== undefined && data.message !== null
                ? h('p', { className: 'bz-note' }, data.message)
                : null,
              available
                ? h(
                    'div',
                    { className: 'bz-update__card' },
                    h(
                      'p',
                      { className: 'bz-note' },
                      '发现新版本 v' +
                        String(data.latestVersion) +
                        '。更新会下载官方安装包、备份当前版本后覆盖，需重启 DSH 生效。',
                    ),
                    confirm === false
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'bz-btn bz-btn--primary bz-btn--sm',
                            'data-update-confirm': 'true',
                            onClick: function () {
                              setConfirm(true)
                            },
                          },
                          '立即更新',
                        )
                      : h(
                          'span',
                          { className: 'bz-update__confirm' },
                          h('span', null, '确认更新到 v' + String(data.latestVersion) + '？'),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'bz-btn bz-btn--primary bz-btn--sm',
                              'data-update-apply': 'true',
                              disabled: busy === true,
                              onClick: async function () {
                                setBusy(true)
                                try {
                                  var result = await postJson(ROUTES.updateAction, {})
                                  var text = textOf(result?.message) || '已提交更新。'
                                  props.onNotice?.(text, result?.ok === false ? 'error' : 'ok')
                                  setConfirm(false)
                                  void loadUpdate()
                                } catch (error) {
                                  props.onNotice?.(messageOf(error), 'error')
                                } finally {
                                  setBusy(false)
                                }
                              },
                            },
                            busy === true ? '更新中…' : '确认更新',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'bz-btn bz-btn--sm',
                              onClick: function () {
                                setConfirm(false)
                              },
                            },
                            '取消',
                          ),
                        ),
                  )
                : h(Tag, { kind: 'ok' }, '已是最新版本'),
            )
          : null,
      )
    }

    /**
     * 屏 A 容器：Provider 栏（一 provider 一页签）+ 全局启用/禁用联动 + 每页签四块卡片。
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
              providerId: providerId,
              action: action,
              id: item.id,
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
              providerId: providerId,
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
              providerId: providerId,
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
              providerId: providerId,
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

      /** 全局启用/禁用：整台机器上这家库到底出不出现在界面里。 */
      var toggleProviderEnabled = React.useCallback(
        async function (providerId, enabled) {
          try {
            await postJson(ROUTES.providerEnabled(providerId), {
              providerId: providerId,
              enabled: enabled,
            })
            showNotice(
              enabled === true
                ? '已启用该 Provider：它会在会话面板与完整面板中出现。'
                : '已禁用该 Provider：它的专家、技能与连接器不再出现在会话面板与完整面板。',
            )
            await loadProviders()
          } catch (error) {
            showNotice('切换失败：' + messageOf(error), 'error')
          }
        },
        [loadProviders, showNotice],
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
                providerId: providerId,
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
                providerId: providerId,
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
          h('h3', { className: 'bz-title' }, '集市设置'),
          h(
            StateBlock,
            { kind: 'loading', title: '正在读取 Provider 栏…' },
            h(Skeleton, { widths: ['w60', 'w80'] }),
          ),
          h(Notice, { notice: notice }),
        )
      }
      if (list.phase === 'error') {
        return h(
          'div',
          { className: 'bz-settings' },
          h('h3', { className: 'bz-title' }, '集市设置'),
          h(
            StateBlock,
            { kind: 'error', title: 'Provider 注册表读取失败' },
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
          h('h3', { className: 'bz-title' }, '集市设置'),
          h(
            'div',
            { className: 'bz-empty' },
            h('h4', null, '暂无已注册的专家库', ' ', h(Tag, { kind: 'empty' }, '空数据')),
            h(
              'p',
              { className: 'bz-sub' },
              '注册表为空。安装并启用一个 provider 后，Provider 栏会按 displayName 自动出现页签，无需改界面代码。',
            ),
          ),
          h(Notice, { notice: notice }),
        )
      }
      var enabledCount = 0
      for (var countIndex = 0; countIndex < list.items.length; countIndex += 1) {
        if (list.items[countIndex].enabled !== false) enabledCount += 1
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
            'data-disabled': item.enabled === false ? 'true' : 'false',
            'aria-selected': active === item.id ? 'true' : 'false',
            'aria-controls': 'pane-' + item.id,
            tabIndex: active === item.id ? 0 : -1,
            onClick: function () {
              setActive(item.id)
              setConfirm(null)
            },
          },
          h('span', null, item.displayName),
          pane.phase === 'loading' ? h(Tag, { kind: 'loading' }, '加载中') : null,
          pane.phase === 'error' ? h(Tag, { kind: 'error' }, '出错') : null,
          item.enabled === false ? h(Tag, { kind: 'disabled' }, '已禁用') : null,
        )
      })
      var defaultHint = null
      var defaultId = textOf(list.defaultProvider)
      if (defaultId !== '' && list.activeProviders.indexOf(defaultId) === -1) {
        var registered = false
        for (var j = 0; j < list.items.length; j += 1) {
          if (list.items[j].id === defaultId) registered = true
        }
        if (registered === false) {
          defaultHint = h(
            'p',
            { className: 'bz-error' },
            '默认专家库 ' +
              defaultId +
              ' 未注册：已回落为首个已注册的专家库，请修正 defaultProvider。',
          )
        }
      }
      var banner =
        currentProvider === null
          ? null
          : h(
              'div',
              {
                className: 'bz-banner',
                'data-enabled': currentProvider.enabled === false ? 'false' : 'true',
              },
              h(
                'div',
                { className: 'bz-banner__meta' },
                h(
                  'div',
                  { className: 'bz-banner__title' },
                  h('span', null, currentProvider.displayName),
                  h(
                    'span',
                    { className: 'bz-tag bz-mono', 'data-kind': 'muted' },
                    currentProvider.id,
                  ),
                  h(
                    Tag,
                    { kind: currentProvider.enabled === false ? 'disabled' : 'ok' },
                    currentProvider.enabled === false
                      ? '已禁用 · 不在会话面板显示'
                      : '已启用 · 在会话面板显示',
                  ),
                ),
                h(
                  'p',
                  { className: 'bz-banner__desc' },
                  '已声明：' +
                    declaredList(currentProvider.capabilities) +
                    '。禁用后该 Provider 的专家、技能与连接器不进入会话面板与完整面板；会话里已做的选择会被冻结保留，重新启用即恢复。',
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-switch-pill',
                  role: 'switch',
                  'aria-checked': currentProvider.enabled === false ? 'false' : 'true',
                  'aria-label': '启用 ' + currentProvider.displayName,
                  'data-settings-switch': currentProvider.id,
                  'data-on': currentProvider.enabled === false ? 'false' : 'true',
                  onClick: function () {
                    if (currentProvider === null) return
                    void toggleProviderEnabled(
                      currentProvider.id,
                      currentProvider.enabled === false,
                    )
                  },
                },
                h('span', { className: 'bz-switch-track', 'aria-hidden': 'true' }),
                h('span', null, currentProvider.enabled === false ? '已禁用' : '已启用'),
              ),
            )
      return h(
        'div',
        { className: 'bz-settings' },
        h(
          'div',
          { className: 'bz-settings__head' },
          h(
            'div',
            null,
            h('h3', { className: 'bz-title' }, '集市设置'),
            h(
              'p',
              { className: 'bz-sub' },
              '配色跟随 DSH 宿主主题自动适配深浅色；以下按 Provider 分页管理。当前启用 ' +
                String(enabledCount) +
                ' / ' +
                String(list.items.length) +
                ' 个 Provider。',
            ),
          ),
        ),
        h('div', { className: 'bz-tabs', role: 'tablist', 'aria-label': 'Provider 栏' }, tabs),
        defaultHint,
        banner,
        enabledCount === 0
          ? h(
              'div',
              { className: 'bz-inline-alert', role: 'alert' },
              h(
                'span',
                null,
                '所有 Provider 都已在设置页禁用：会话面板将显示空态并引导回到本页启用。',
              ),
            )
          : null,
        h(VersionUpdateBlock, { onNotice: showNotice }),
        currentProvider === null
          ? null
          : h(SettingsPane, {
              provider: currentProvider,
              pane: currentPane,
              muted: currentProvider.enabled === false,
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

    // ── 屏 B：集市面板的数据层 ────────────────────────────────────────────────

    /**
     * 分类标签：按域给固定的几组（空 id = 全部）。
     *
     * 专家的 data/eng/doc 三个领域分类与原型一致：值来自 provider 自己在条目上声明的
     * `category`，不是这里凭空分区。空 id 仍然表示「不筛」，所以过滤器不必区分
     * 「没点过」和「点了全部」。
     */
    var CATEGORIES = {
      expert: [
        { id: '', label: '全部' },
        { id: 'data', label: '数据' },
        { id: 'eng', label: '工程' },
        { id: 'doc', label: '文档' },
        { id: 'installed', label: '已安装' },
      ],
      skill: [
        { id: '', label: '全部' },
        { id: 'skillMarket', label: '技能市场' },
        { id: 'memoryMarket', label: '记忆能力' },
        { id: 'installed', label: '已安装' },
      ],
      connector: [
        { id: '', label: '全部' },
        { id: 'connected', label: '已连接' },
        { id: 'authorize', label: '需授权' },
        { id: 'disabled', label: '本会话停用' },
      ],
    }

    var SEARCH_PLACEHOLDER = {
      expert: '搜索专家名称、专长领域…',
      skill: '搜索技能或记忆能力…',
      connector: '搜索连接器或工具…',
    }

    /**
     * 分类标签：专家优先消费服务端 `/dsh-bazaar/state` 返回的真实市场分类，
     * 缺失时退回内置兜底分组；技能与连接器使用固定语义标签。
     */
    function categoriesFor(kind, panelData) {
      if (
        kind === 'expert' &&
        panelData !== null &&
        panelData !== undefined &&
        Array.isArray(panelData.categories) &&
        panelData.categories.length > 0
      ) {
        var dynamic = [{ id: '', label: '全部' }]
        var seen = { '': true, installed: true }
        var limit = Math.min(panelData.categories.length, 8)
        for (var i = 0; i < limit; i += 1) {
          var item = panelData.categories[i]
          if (item === null || item === undefined) continue
          var cid = textOf(item.id)
          var cname = textOf(item.name === undefined ? item.label : item.name)
          if (cid === '' || cname === '' || seen[cid] === true) continue
          seen[cid] = true
          dynamic.push({ id: cid, label: cname })
        }
        dynamic.push({ id: 'installed', label: '已安装' })
        return dynamic
      }
      return CATEGORIES[kind] === undefined ? [] : CATEGORIES[kind]
    }

    /** 把下一页分组按 providerId 追加合并进已有分组（避免重复行）。 */
    function mergeDomainGroups(previousGroups, nextGroups) {
      var prev = Array.isArray(previousGroups) ? previousGroups : []
      var next = Array.isArray(nextGroups) ? nextGroups : []
      var out = prev.slice()
      for (var n = 0; n < next.length; n += 1) {
        var incoming = next[n]
        var at = -1
        for (var p = 0; p < out.length; p += 1) {
          if (out[p].providerId === incoming.providerId) at = p
        }
        if (at === -1) {
          out.push(incoming)
          continue
        }
        var base = out[at]
        var seen = Object.create(null)
        var mergedItems = []
        var baseItems = Array.isArray(base.items) ? base.items : []
        var addItems = Array.isArray(incoming.items) ? incoming.items : []
        for (var i = 0; i < baseItems.length; i += 1) {
          var keyA = textOf(baseItems[i].slug || baseItems[i].id)
          if (keyA !== '') seen[keyA] = true
          mergedItems.push(baseItems[i])
        }
        for (var j = 0; j < addItems.length; j += 1) {
          var keyB = textOf(addItems[j].slug || addItems[j].id)
          if (keyB !== '' && seen[keyB] === true) continue
          if (keyB !== '') seen[keyB] = true
          mergedItems.push(addItems[j])
        }
        out[at] = Object.assign({}, incoming, { items: mergedItems })
      }
      return out
    }

    /**
     * 统一的一次域取数：把三组接口折成同一种 `{phase, groups, hasMore, page, total, message}`。
     *
     * `providerIds` 只有一个 id 时会把它作为 `provider` 参数发出去，服务端就只问这一家
     * （`lib/provider/domains.js` 的 `targetGroups` 支持该参数）。单库重试靠的就是这条：
     * 重试只重发失败的那一家，别把其他库一起拖动。
     */
    async function fetchDomain(kind, sessionId, providerIds, options) {
      var opts = options === undefined || options === null ? {} : options
      var page = Number(opts.page) > 0 ? Number(opts.page) : 1
      var pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 24
      var query = textOf(opts.query)
      var categoryId = textOf(opts.categoryId)
      var only = Array.isArray(providerIds) && providerIds.length === 1 ? providerIds[0] : null
      if (kind === 'expert') {
        var expertQuery = { sessionId: sessionId, page: page, pageSize: pageSize }
        if (only !== null) expertQuery.provider = only
        if (query !== '') expertQuery.query = query
        if (categoryId !== '' && categoryId !== 'installed') expertQuery.categoryId = categoryId
        var experts = await getJson(ROUTES.experts + queryOf(expertQuery))
        var expertGroups = Array.isArray(experts.groups) ? experts.groups : []
        var expertHasMore =
          experts.hasMore === true ||
          expertGroups.some(function (g) {
            return g.hasMore === true
          })
        return {
          phase: 'ready',
          groups: expertGroups,
          hasMore: expertHasMore,
          page: page,
          total: Number(experts.matchedTotal ?? 0) || 0,
          remoteQuery: query,
          remoteCategory: categoryId,
          message: null,
        }
      }
      if (kind === 'skill') {
        var skillQuery = { sessionId: sessionId, page: page, pageSize: pageSize }
        if (only !== null) skillQuery.provider = only
        if (query !== '') skillQuery.query = query
        var skills = await getJson(ROUTES.skillMarket + queryOf(skillQuery))
        var skillGroups = Array.isArray(skills.groups) ? skills.groups : []
        var skillHasMore =
          skills.hasMore === true ||
          skillGroups.some(function (g) {
            return g.hasMore === true
          })
        var skillTotal = skillGroups.reduce(function (sum, g) {
          return sum + (Number(g.matchedTotal ?? g.total ?? 0) || 0)
        }, 0)
        return {
          phase: 'ready',
          groups: skillGroups,
          hasMore: skillHasMore,
          page: page,
          total: skillTotal,
          remoteQuery: query,
          remoteCategory: '',
          message: null,
        }
      }
      // 连接器：按库并发取，单库失败只红它自己；会话停用表来自扁平路由。
      var disabled = []
      try {
        var flat = await getJson(
          ROUTES.connectors + queryOf({ sessionId: sessionId, view: 'plugins' }),
        )
        if (Array.isArray(flat.disabled)) disabled = flat.disabled.slice()
      } catch (error) {
        void error
      }
      var settled = await Promise.all(
        providerIds.map(function (providerId) {
          var connQuery = { sessionId: sessionId }
          if (query !== '') connQuery.query = query
          return getJson(ROUTES.providerConnectors(providerId) + queryOf(connQuery)).then(
            function (body) {
              var group =
                Array.isArray(body.groups) && body.groups.length > 0 ? body.groups[0] : null
              if (group === null) {
                return {
                  providerId: providerId,
                  displayName: providerId,
                  status: 'ok',
                  items: [],
                  disabled: disabled,
                }
              }
              return {
                providerId: providerId,
                displayName: group.displayName === undefined ? providerId : group.displayName,
                status: group.status === undefined ? 'ok' : group.status,
                code: group.code,
                message: group.message,
                items: Array.isArray(group.items) ? group.items : [],
                disabled: disabled,
              }
            },
            function (error) {
              return {
                providerId: providerId,
                displayName: providerId,
                status: 'error',
                message: messageOf(error),
                items: [],
                disabled: disabled,
              }
            },
          )
        }),
      )
      return {
        phase: 'ready',
        groups: settled,
        hasMore: false,
        page: 1,
        total: settled.reduce(function (sum, g) {
          return sum + (Array.isArray(g.items) ? g.items.length : 0)
        }, 0),
        remoteQuery: query,
        remoteCategory: '',
        message: null,
      }
    }

    /** 把 domain 结果拍平成行，并补上 providerId / 稳定 id / 显示名。 */
    function rowsOf(kind, domain) {
      var rows = []
      if (domain === null || domain === undefined) return rows
      var groups = Array.isArray(domain.groups) ? domain.groups : []
      for (var g = 0; g < groups.length; g += 1) {
        var group = groups[g]
        if (group.status === 'error' || group.status === 'undeclared') continue
        var items = Array.isArray(group.items) ? group.items : []
        for (var i = 0; i < items.length; i += 1) {
          var item = items[i]
          var providerId = textOf(item.providerId) === '' ? group.providerId : item.providerId
          var id =
            kind === 'skill'
              ? textOf(item.slug === undefined ? item.id : item.slug)
              : textOf(item.id)
          var installId = kind === 'skill' ? textOf(item.id) || id : id
          var name = textOf(item.name === undefined ? item.displayName : item.name) || id
          rows.push({
            kind: kind,
            id: id,
            installId: installId,
            providerId: providerId,
            providerName: textOf(group.displayName),
            name: name,
            // 跨库同名时服务端给的是带库前缀的限定名。工作台是多库并列，必须用它区分；
            // 上浮面板只有一行高、右侧已挂库名标签，用裸名更省横向空间。
            displayName: textOf(item.qualifiedName) || name,
            description: textOf(item.description),
            source: textOf(item.source),
            // provider 自己声明的领域分类。契约里专家用 `categoryId`，连接器用
            // `category`（还带 local/catalog 这层含义），两个都收，前端按域各取所需。
            category: textOf(item.category === undefined ? item.categoryId : item.category),
            installed: item.installed === true,
            installedBy: item.installedBy === undefined ? null : item.installedBy,
            connected:
              item.state !== undefined && item.state !== null
                ? item.state.connected === true
                : item.authorized === true,
            authorizing:
              item.state !== undefined && item.state !== null
                ? item.state.connecting === true
                : false,
            transport: textOf(item.transport),
            // 契约里 tools 既可能是数量，也可能直接是声明列表；两种都收。
            tools: Array.isArray(item.tools)
              ? item.tools.length
              : Number(item.tools === undefined ? 0 : item.tools) || 0,
            // 目录只读：provider 把连接器声明成「只能复制配置片段」而不是可授权的本地条目。
            catalogOnly: item.catalogOnly === true || item.category === 'catalog',
            // 跨库同名时服务端已经给了带库前缀的限定名，优先用它，避免两行同名无从区分。
            qualifiedName: textOf(item.qualifiedName),
            raw: item,
          })
        }
      }
      return rows
    }

    function filterRows(kind, rows, query, categoryId, disabledIds) {
      var needle = textOf(query).toLowerCase()
      var out = []
      for (var index = 0; index < rows.length; index += 1) {
        var row = rows[index]
        if (categoryId === 'installed' && row.installed !== true) continue
        if (categoryId === 'skillMarket' && row.source !== 'skillMarket') continue
        if (categoryId === 'memoryMarket' && row.source !== 'memoryMarket') continue
        if (categoryId === 'connected' && row.connected !== true) continue
        if (categoryId === 'authorize' && row.connected === true) continue
        if (categoryId === 'disabled' && disabledIds.indexOf(row.id) === -1) continue
        // 领域分类（data/eng/doc…）是 provider 在条目上自己声明的 `category`；
        // 不认识的 id 一律当领域分类比，避免把新加的分类悄悄筛成空集。
        if (
          categoryId !== '' &&
          [
            'installed',
            'skillMarket',
            'memoryMarket',
            'connected',
            'authorize',
            'disabled',
          ].indexOf(categoryId) === -1 &&
          row.category !== categoryId
        ) {
          continue
        }
        if (needle !== '') {
          var hay = (
            row.name +
            ' ' +
            row.description +
            ' ' +
            row.id +
            ' ' +
            row.providerName
          ).toLowerCase()
          if (hay.includes(needle) !== true) continue
        }
        out.push(row)
      }
      return out
    }

    /**
     * 一行条目的右侧操作区。
     *
     * 这一处是「谁能做什么」的唯一判定点：专家可选用 / 技能可安装 / 连接器可授权或
     * 会停用。三种状态的文字必须互相可区分（当前使用、已安装、需授权…），不能只靠颜色。
     *
     * 四种「不能做」的原因也在这里判，且必须写明是哪种不能做（`test/two-screen-e2e`
     * 逐条断言文字）：
     * 1. 本会话没选这家库 → 「禁用：未选择该专家库」，条目仍然列出来（只读可见）；
     * 2. 技能已被别的库装过 → 「冲突」+ 禁用安装，并给出跨来源同名不覆盖的原因；
     * 3. 已安装 → 「已安装 · 只读」，只能重装不能改来源；
     * 4. 连接器只读目录项 → 「目录只读」+ 复制配置片段。
     */
    function RowActions(props) {
      var row = props.row
      var kind = props.kind
      var busy = props.busy === itemKey(row.providerId, row.id)
      var providerActive = props.providerActive !== false
      var conflictOwner = textOf(props.conflictOwner)
      var side = []
      if (providerActive !== true) {
        // 未选库只给一句话：说清是哪一种不能做，不留只靠灰度的「禁用感」。
        side.push(
          h(
            Tag,
            { key: 'off', kind: 'disabled' },
            kind === 'expert' ? '禁用：未选择该专家库' : '禁用：未选中',
          ),
        )
      } else if (kind === 'expert') {
        if (props.selected === true) {
          side.push(h(Tag, { key: 'cur', kind: 'info' }, '当前使用'))
          side.push(
            h(
              'button',
              {
                key: 'picked',
                type: 'button',
                className: 'bz-btn bz-btn--sm',
                disabled: true,
              },
              '已选',
            ),
          )
          side.push(
            h(
              'button',
              {
                key: 'clear',
                type: 'button',
                className: 'bz-btn bz-btn--sm bz-btn--ghost',
                'data-clear-expert': row.providerId,
                disabled: busy,
                onClick: function () {
                  props.onClearExpert()
                },
              },
              '退出',
            ),
          )
        } else {
          side.push(
            h(
              'button',
              {
                key: 'pick',
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                'data-pick-expert': itemKey(row.providerId, row.id),
                disabled: busy,
                onClick: function () {
                  props.onPick()
                },
              },
              busy === true ? '应用中…' : '选择',
            ),
          )
        }
      } else if (kind === 'skill') {
        if (conflictOwner !== '') {
          side.push(h(Tag, { key: 'conflict', kind: 'danger' }, '冲突'))
          side.push(
            h(
              'button',
              {
                key: 'install',
                type: 'button',
                className: 'bz-btn bz-btn--sm',
                'data-install-skill': itemKey(row.providerId, row.id),
                disabled: true,
                onClick: function () {
                  props.onInstall(false)
                },
              },
              '安装',
            ),
          )
        } else if (row.installed === true) {
          side.push(h(Tag, { key: 'ok', kind: 'ok' }, '已安装 · 只读'))
          side.push(
            h(
              'button',
              {
                key: 'reinstall',
                type: 'button',
                className: 'bz-btn bz-btn--sm bz-btn--ghost',
                'data-install-skill': itemKey(row.providerId, row.id),
                disabled: busy,
                onClick: function () {
                  props.onInstall(true)
                },
              },
              busy === true ? '安装中…' : '重装',
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
                'data-install-skill': itemKey(row.providerId, row.id),
                disabled: busy,
                onClick: function () {
                  props.onInstall(false)
                },
              },
              busy === true ? '安装中…' : '安装',
            ),
          )
        }
      } else if (row.catalogOnly === true) {
        // 目录只读条目：只能把配置片段抄走，不做授权（授权要 provider 自己支持）。
        side.push(h(Tag, { key: 'catalog', kind: 'muted' }, '目录只读'))
        side.push(
          h(
            'button',
            {
              key: 'copy',
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              'data-copy-config': itemKey(row.providerId, row.id),
              onClick: function () {
                props.onCopyConfig(row)
              },
            },
            '复制片段',
          ),
        )
      } else if (row.connected === true) {
        var sessionOff = props.sessionDisabled === true
        side.push(
          h(
            Tag,
            { key: 'conn', kind: sessionOff ? 'muted' : 'ok' },
            sessionOff ? '本会话停用' : '已连接',
          ),
        )
        side.push(
          h(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              'data-toggle-connector': row.id,
              onClick: function () {
                props.onToggleConnector()
              },
            },
            sessionOff === true ? '启用' : '停用',
          ),
        )
        side.push(
          h(
            'button',
            {
              key: 'copy',
              type: 'button',
              className: 'bz-btn bz-btn--sm bz-btn--ghost',
              'data-copy-config': itemKey(row.providerId, row.id),
              onClick: function () {
                props.onCopyConfig(row)
              },
            },
            '复制片段',
          ),
        )
      } else {
        side.push(
          h(Tag, { key: 'need', kind: 'warn' }, row.authorizing === true ? '授权中' : '需授权'),
        )
        side.push(
          h(
            'button',
            {
              key: 'auth',
              type: 'button',
              className: 'bz-btn bz-btn--primary bz-btn--sm',
              'data-authorize-connector': itemKey(row.providerId, row.id),
              disabled: busy || row.authorizing === true,
              onClick: function () {
                props.onAuthorize()
              },
            },
            row.authorizing === true ? '授权中…' : '授权',
          ),
        )
      }
      return h('div', { className: 'bz-doubao-row__side' }, side)
    }

    /** 冲突条目的说明详情：写清为什么不覆盖，别让人以为是漏了后缀。 */
    function ConflictDetails(props) {
      var owner = textOf(props.owner)
      if (owner === '') return null
      return h(
        'details',
        { className: 'bz-conflict-details' },
        h('summary', null, '查看已有安装（已被 ' + owner + ' 安装）'),
        h(
          'p',
          null,
          '目标目录 ',
          h('code', { className: 'bz-mono' }, '.dsh/skills/' + textOf(props.slug) + '/'),
          ' 已由 ',
          owner,
          ' 安装，跨来源同名不覆盖、不加后缀。',
        ),
      )
    }

    /** 上浮面板的一行：图标 + 名称 + 一行简介 + 右侧状态/操作。 */
    function MarketRow(props) {
      var row = props.row
      var kind = props.kind
      var showLib = props.showLibrary === true
      var tone =
        kind === 'expert'
          ? 'blue'
          : kind === 'skill'
            ? row.source === 'memoryMarket'
              ? 'amber'
              : 'green'
            : row.connected === true
              ? 'green'
              : 'blue'
      // 行本身的「不可操作」只有一个原因：它所属的库没在本会话被选中。
      // 其余不可操作（已安装、冲突、目录只读）由右侧操作区各自说明，别在这一层重复表达。
      var offSession = props.providerActive !== false && props.providerActive !== true
      return h(
        'div',
        {
          className: 'bz-doubao-row',
          'data-row-kind': kind,
          'data-id': row.id,
          'data-provider': row.providerId,
          'data-selected': props.selected === true ? 'true' : 'false',
          'data-disabled': offSession === true ? 'true' : 'false',
          role: 'listitem',
        },
        h(
          'div',
          { className: 'bz-doubao-row__main' },
          h(
            'span',
            { className: 'bz-doubao-row__icon', 'data-tone': tone, 'aria-hidden': 'true' },
            kind === 'skill' && row.source === 'memoryMarket' ? memoryIcon(13) : kindIcon(kind, 13),
          ),
          h(
            'div',
            { className: 'bz-doubao-row__text' },
            h(
              'span',
              { className: 'bz-doubao-row__name' },
              row.name,
              showLib === true && textOf(row.providerName) !== ''
                ? h(Tag, { kind: 'muted' }, row.providerName)
                : null,
              kind === 'skill' && row.source === 'memoryMarket'
                ? h(Tag, { kind: 'info' }, '记忆')
                : null,
            ),
            h(
              'span',
              { className: 'bz-doubao-row__desc' },
              row.description === '' ? '（无描述）' : row.description,
            ),
          ),
        ),
        h(RowActions, {
          kind: kind,
          row: row,
          busy: props.busy,
          selected: props.selected,
          sessionDisabled: props.sessionDisabled,
          providerActive: props.providerActive,
          conflictOwner: props.conflictOwner,
          onPick: props.onPick,
          onClearExpert: props.onClearExpert,
          onInstall: props.onInstall,
          onToggleConnector: props.onToggleConnector,
          onAuthorize: props.onAuthorize,
          onCopyConfig: props.onCopyConfig,
        }),
      )
    }

    // ── 屏 B：完整面板（工作台）──────────────────────────────────────────────

    /**
     * 完整面板：多 provider 并列的工作台。
     *
     * 三个域页签（专家 / 技能与记忆 / 连接器）共用同一份 provider 开关组；开关写的是
     * **本会话**的活跃集（`providers/active`），不是设置页的全局开关——后者只在屏 A 拨。
     */
    function SessionPanel(props) {
      var providersPair = React.useState({
        phase: 'loading',
        items: [],
        activeProviders: [],
        message: null,
      })
      var providers = providersPair[0]
      var setProviders = providersPair[1]
      var panelPair = React.useState({ phase: 'loading', data: null, message: null })
      var panel = panelPair[0]
      var setPanel = panelPair[1]
      var tabPair = React.useState(props.initialTab === undefined ? 'expert' : props.initialTab)
      var tab = tabPair[0]
      var setTab = tabPair[1]
      var queryPair = React.useState('')
      var query = queryPair[0]
      var setQuery = queryPair[1]
      // 分类与搜索都只在本地筛（`filterRows`），不发新请求：面板是即时过滤的，
      // 每敲一个字都回一趟服务端会让「多库并列」变成一串互相打断的请求。
      var categoryPair = React.useState('')
      var category = categoryPair[0]
      var setCategory = categoryPair[1]
      var domainPair = React.useState({ phase: 'loading', groups: [], message: null })
      var domain = domainPair[0]
      var setDomain = domainPair[1]
      var disabledPair = React.useState([])
      var disabledConnectors = disabledPair[0]
      var setDisabledConnectors = disabledPair[1]
      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var noticePair = React.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var tickPair = React.useState(0)
      var tick = tickPair[0]
      var setTick = tickPair[1]
      var loadingMorePair = React.useState(false)
      var loadingMore = loadingMorePair[0]
      var setLoadingMore = loadingMorePair[1]
      var searchTimerRef = React.useRef(null)
      var noticeTimerRef = React.useRef(null)
      var autoActivatedRef = React.useRef(false)
      var domainRef = React.useRef(domain)
      domainRef.current = domain

      var showNotice = React.useCallback(function (text, kind) {
        if (noticeTimerRef.current !== null) {
          clearTimeout(noticeTimerRef.current)
          noticeTimerRef.current = null
        }
        setNotice({ text: text, kind: kind === undefined ? 'ok' : kind })
        var timer = setTimeout(function () {
          noticeTimerRef.current = null
          setNotice(null)
        }, 3500)
        if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') {
          timer.unref()
        }
        noticeTimerRef.current = timer
      }, [])

      var activeKey =
        (Array.isArray(providers.activeProviders) ? providers.activeProviders.join(',') : '') +
        '#' +
        String(tick)

      var loadProviders = React.useCallback(
        async function () {
          try {
            var body = await getJson(ROUTES.providers + queryOf({ sessionId: props.sessionId }))
            var items = Array.isArray(body.items) ? body.items : []
            var activeList = Array.isArray(body.activeProviders) ? body.activeProviders : []
            setProviders({
              phase: 'ready',
              items: items,
              activeProviders: activeList,
              message: null,
            })
            if (
              body.initialized === false &&
              activeList.length === 0 &&
              textOf(props.sessionId) !== '' &&
              autoActivatedRef.current !== true
            ) {
              var autoIds = items
                .filter(function (item) {
                  return item.enabled !== false
                })
                .map(function (item) {
                  return item.id
                })
              if (autoIds.length > 0) {
                autoActivatedRef.current = true
                try {
                  await postJson(ROUTES.providersActive, {
                    sessionId: props.sessionId,
                    activeProviders: autoIds,
                  })
                  setProviders({
                    phase: 'ready',
                    items: items,
                    activeProviders: autoIds.slice(),
                    message: null,
                  })
                  setTick(function (previous) {
                    return previous + 1
                  })
                } catch (err) {
                  void err
                }
              }
            }
          } catch (error) {
            setProviders({
              phase: 'error',
              items: [],
              activeProviders: [],
              message: messageOf(error),
            })
          }
        },
        [props.sessionId],
      )

      var loadPanel = React.useCallback(
        async function () {
          try {
            var body = await getJson(ROUTES.state + queryOf({ sessionId: props.sessionId }))
            var payload = body.state === undefined ? body : body.state
            setPanel({ phase: 'ready', data: payload, message: null })
            if (typeof props.onStateChange === 'function') props.onStateChange(payload)
          } catch (error) {
            setPanel({ phase: 'error', data: null, message: messageOf(error) })
          }
        },
        [props.sessionId, props.onStateChange],
      )

      var runRemoteSearch = React.useCallback(
        async function (nextQuery, nextCategory) {
          var ids = Array.isArray(providers.activeProviders) ? providers.activeProviders : []
          if (ids.length === 0) return
          setDomain(function (previous) {
            return Object.assign({}, previous, { phase: 'loading', message: null })
          })
          try {
            var result = await fetchDomain(tab, props.sessionId, ids, {
              query: nextQuery,
              categoryId: nextCategory,
              page: 1,
            })
            setDomain(result)
          } catch (error) {
            setDomain({ phase: 'error', groups: [], message: messageOf(error) })
          }
        },
        [props.sessionId, providers.activeProviders, tab],
      )

      var loadMore = React.useCallback(
        async function () {
          var ids = Array.isArray(providers.activeProviders) ? providers.activeProviders : []
          var current = domainRef.current
          if (ids.length === 0 || current.hasMore !== true || loadingMore === true) return
          setLoadingMore(true)
          try {
            var nextPage = (Number(current.page) || 1) + 1
            var result = await fetchDomain(tab, props.sessionId, ids, {
              query: textOf(current.remoteQuery),
              categoryId: textOf(current.remoteCategory),
              page: nextPage,
            })
            setDomain(function (previous) {
              return {
                phase: 'ready',
                groups: mergeDomainGroups(previous.groups, result.groups),
                hasMore: result.hasMore,
                page: nextPage,
                total: result.total,
                remoteQuery: result.remoteQuery,
                remoteCategory: result.remoteCategory,
                message: null,
              }
            })
          } catch (error) {
            showNotice('加载更多失败：' + messageOf(error), 'error')
          } finally {
            setLoadingMore(false)
          }
        },
        [loadingMore, props.sessionId, providers.activeProviders, showNotice, tab],
      )

      React.useEffect(function () {
        return function () {
          if (searchTimerRef.current !== null) {
            clearTimeout(searchTimerRef.current)
            searchTimerRef.current = null
          }
          if (noticeTimerRef.current !== null) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = null
          }
        }
      }, [])

      React.useEffect(
        function () {
          void loadProviders()
        },
        [loadProviders],
      )

      React.useEffect(
        function () {
          void loadPanel()
        },
        [loadPanel, tick],
      )

      React.useEffect(
        function () {
          if (providers.phase !== 'ready') return undefined
          var ids = Array.isArray(providers.activeProviders) ? providers.activeProviders : []
          if (ids.length === 0) {
            setDomain({
              phase: 'ready',
              groups: [],
              hasMore: false,
              page: 1,
              total: 0,
              message: null,
            })
            return undefined
          }
          var cancelled = false
          setDomain({
            phase: 'loading',
            groups: [],
            hasMore: false,
            page: 1,
            total: 0,
            message: null,
          })
          fetchDomain(tab, props.sessionId, ids).then(
            function (result) {
              if (cancelled === true) return
              setDomain(result)
              var first = result.groups.length > 0 ? result.groups[0] : null
              if (tab === 'connector' && first !== null && Array.isArray(first.disabled)) {
                setDisabledConnectors(first.disabled.slice())
              }
            },
            function (error) {
              if (cancelled === true) return
              setDomain({
                phase: 'error',
                groups: [],
                hasMore: false,
                page: 1,
                total: 0,
                message: messageOf(error),
              })
            },
          )
          return function () {
            cancelled = true
          }
        },
        [activeKey, props.sessionId, tab, providers.phase, providers.activeProviders],
      )

      /**
       * 只重发一家库：把 `fetchDomain` 限定成单 provider（它会带上 `provider` 参数），
       * 回来只替换那一组，其余分组原样保留。这样重试不会把正常库一起卷进来重刷，
       * 也就不会让已经显示好的条目闪一下再回来。
       */
      var retryGroup = React.useCallback(
        async function (providerId) {
          setDomain(function (previous) {
            return { phase: 'loading', groups: previous.groups, message: null }
          })
          try {
            var result = await fetchDomain(tab, props.sessionId, [providerId])
            setDomain(function (previous) {
              var merged = previous.groups.slice()
              for (var index = 0; index < result.groups.length; index += 1) {
                var next = result.groups[index]
                var at = -1
                for (var cursor = 0; cursor < merged.length; cursor += 1) {
                  if (merged[cursor].providerId === next.providerId) at = cursor
                }
                if (at === -1) merged.push(next)
                else merged[at] = next
              }
              return { phase: 'ready', groups: merged, message: null }
            })
          } catch (error) {
            showNotice('重试失败：' + messageOf(error), 'error')
          }
        },
        [props.sessionId, showNotice, tab],
      )

      var applyActive = React.useCallback(
        async function (nextIds) {
          try {
            await postJson(ROUTES.providersActive, {
              sessionId: props.sessionId,
              activeProviders: nextIds,
            })
            // 写成功后立刻本地回填：开关与卡片都读 `providers.activeProviders`，
            // 不回填就要等下一次整份重取，中间那一下点击会拿着旧集算出同样的 next，
            // 看上去就是「点第二次没反应」。
            setProviders(function (previous) {
              return {
                phase: previous.phase,
                items: previous.items,
                message: previous.message,
                activeProviders: nextIds.slice(),
              }
            })
            showNotice(
              nextIds.length === 0
                ? '已清空本会话的来源：全不勾选是合法空态，勾选任意一家即可继续浏览。'
                : '已在当前会话启用 ' + String(nextIds.length) + ' 个来源。',
            )
            setTick(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('切换失败：' + messageOf(error), 'error')
          }
        },
        [props.sessionId, showNotice],
      )

      var pickExpert = React.useCallback(
        async function (row) {
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.select, {
              sessionId: props.sessionId,
              expertId: row.id,
              providerId: row.providerId,
            })
            rememberRecent('expert', row)
            showNotice('已选择 ' + row.name + '：下一条消息生效。')
            await loadPanel()
            setTick(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('选择失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [loadPanel, props.sessionId, showNotice],
      )

      var installSkill = React.useCallback(
        async function (row, force) {
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.skillInstall, {
              sessionId: props.sessionId,
              providerId: row.providerId,
              skillId: textOf(row.installId) || row.id,
              force: force === true,
            })
            rememberRecent('skill', row)
            showNotice('已安装技能 ' + row.id + '。')
            setTick(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('安装失败：' + messageOf(error), 'error')
            setTick(function (previous) {
              return previous + 1
            })
          } finally {
            setBusy(null)
          }
        },
        [props.sessionId, showNotice],
      )

      var toggleConnector = React.useCallback(
        async function (row) {
          var next = disabledConnectors.slice()
          var at = next.indexOf(row.id)
          if (at === -1) next.push(row.id)
          else next.splice(at, 1)
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.connectorsSession, {
              sessionId: props.sessionId,
              disabled: next,
            })
            setDisabledConnectors(next)
            showNotice(at === -1 ? '已在本会话停用该连接器。' : '已在本会话启用该连接器。')
          } catch (error) {
            showNotice('切换失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [disabledConnectors, props.sessionId, showNotice],
      )

      var authorizeConnector = React.useCallback(
        async function (row) {
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.providerConnectorAction(row.providerId), {
              providerId: row.providerId,
              action: 'authorize',
              id: row.id,
              sessionId: props.sessionId,
            })
            showNotice('已发起授权，请按提示完成。')
            setTick(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('授权失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [props.sessionId, showNotice],
      )

      var clearExpert = React.useCallback(
        async function (row) {
          try {
            await postJson(ROUTES.off, { sessionId: props.sessionId })
            showNotice('已退出当前专家，恢复默认助手。')
            await loadPanel()
            setTick(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('操作失败：' + messageOf(error), 'error')
            void row
          }
        },
        [loadPanel, props.sessionId, showNotice],
      )

      /**
       * 复制连接器配置片段。只产出文本，不写宿主配置——写配置是 armory 的事，
       * 这里越界改 `cordis.patch.yml` 就成了「点一下按钮悄悄改了宿主」。
       */
      var copyConfig = React.useCallback(
        async function (row) {
          try {
            var body = await postJson(ROUTES.providerConnectorAction(row.providerId), {
              providerId: row.providerId,
              action: 'copy-config',
              id: row.id,
              sessionId: props.sessionId,
            })
            var snippet = textOf(body.text) === '' ? textOf(body.config) : body.text
            var copied = await copyText(snippet)
            showNotice(
              copied === true
                ? '配置片段已复制（只产出文本，不改宿主配置）'
                : '配置片段：' + snippet,
            )
          } catch (error) {
            showNotice('复制失败：' + messageOf(error), 'error')
          }
        },
        [props.sessionId, showNotice],
      )

      var activeIds = Array.isArray(providers.activeProviders) ? providers.activeProviders : []
      var enabledProviders = providers.items.filter(function (item) {
        return item.enabled !== false
      })
      var currentExpert = panel.data === null ? null : panel.data.expert
      var rows = filterRows(tab, rowsOf(tab, domain), query, category, disabledConnectors)

      /** providerId → 显示名。跨库冲突时要把「谁装过」写成人能读的名字。 */
      function displayNameOf(providerId) {
        for (var index = 0; index < enabledProviders.length; index += 1) {
          if (enabledProviders[index].id === providerId) return enabledProviders[index].displayName
        }
        for (var cursor = 0; cursor < providers.items.length; cursor += 1) {
          if (providers.items[cursor].id === providerId) return providers.items[cursor].displayName
        }
        return providerId
      }

      /**
       * 技能被别的库装过 → 返回那家的显示名，否则返回空串。
       *
       * 判据只看 `installedBy` 与自身 providerId 是否不同：同一家库自己装的属于「已安装」，
       * 不是冲突。跨来源同名不覆盖、不加后缀是仓库既定语义（`.dsh/skills/<slug>/` 只有一个
       * 目标目录），所以这里既不能「覆盖安装」也不能「自动改名」。
       */
      function conflictOwnerOf(row) {
        var owner =
          row.installedBy === null || row.installedBy === undefined ? '' : textOf(row.installedBy)
        if (owner === '' || owner === row.providerId) return ''
        return displayNameOf(owner)
      }

      /** 工作台里的一行：标题 + 描述 + 右侧操作。 */
      function renderWorkbenchItem(row, provider, activeIdsNow) {
        return h(
          'div',
          { key: itemKey(row.providerId, row.id), className: 'bz-workbench-item' },
          h(
            'div',
            { className: 'bz-workbench-item__main' },
            h(
              'div',
              { className: 'bz-workbench-item__title' },
              // 多库并列时必须用限定名：两个库都叫「数据工程师」时，裸名无法区分。
              h('span', null, row.displayName),
              tab === 'connector' ? h(Tag, { kind: 'muted' }, row.transport) : null,
              tab === 'connector' ? h(Tag, { kind: 'muted' }, String(row.tools) + ' 工具') : null,
              tab === 'skill' ? h('span', { className: 'bz-mono bz-note' }, row.id) : null,
            ),
            h('p', { className: 'bz-workbench-item__desc' }, row.description),
            tab === 'skill'
              ? h(ConflictDetails, { owner: conflictOwnerOf(row), slug: row.id })
              : null,
          ),
          h(RowActions, {
            kind: tab,
            row: row,
            busy: busy,
            providerActive: activeIdsNow.indexOf(row.providerId) !== -1,
            conflictOwner: conflictOwnerOf(row),
            selected: isExpertSelected(currentExpert, row),
            sessionDisabled: disabledConnectors.indexOf(row.id) !== -1,
            onPick: function () {
              void pickExpert(row)
            },
            onClearExpert: function () {
              void clearExpert(row)
            },
            onInstall: function (force) {
              void installSkill(row, force)
            },
            onToggleConnector: function () {
              void toggleConnector(row)
            },
            onAuthorize: function () {
              void authorizeConnector(row)
            },
            onCopyConfig: function (target) {
              void copyConfig(target)
            },
          }),
        )
      }

      /**
       * 技能分区固定拆成「技能市场」与「记忆市场」两段。
       *
       * 两段的状态必须分别表达：记忆市场未声明时给「禁用：未声明 memoryMarket」+ 一句解释，
       * 不能拿「暂无条目」冒充空态——前者是「这家库没有这个能力」，后者是「有这个能力但
       * 现在没东西」，让人以为再等等就会出来。
       */
      function renderSkillSections(provider, group, groupRows, activeIdsNow) {
        var sources = group.sources === undefined || group.sources === null ? {} : group.sources
        var market = sources.skillMarket === undefined ? null : sources.skillMarket
        var memory = sources.memoryMarket === undefined ? null : sources.memoryMarket
        var marketRows = groupRows.filter(function (row) {
          return row.source !== 'memoryMarket'
        })
        var memoryRows = groupRows.filter(function (row) {
          return row.source === 'memoryMarket'
        })
        function rowList(list, emptyText) {
          if (list.length === 0) {
            return h(StateBlock, { kind: 'empty', title: emptyText }, null)
          }
          return list.map(function (row) {
            return renderWorkbenchItem(row, provider, activeIdsNow)
          })
        }
        var memoryUndeclared = memory !== null && memory.status === 'undeclared'
        var memoryOff = memory === null || memory.status !== 'ok'
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'bz-subhead' },
            h('span', null, '技能市场'),
            market === null || market.status === 'ok'
              ? h(Tag, { kind: 'readonly' }, 'skillMarket')
              : h(Tag, { kind: 'disabled' }, '禁用：未声明 skillMarket'),
          ),
          market === null || market.status === 'ok'
            ? rowList(marketRows, '无匹配技能')
            : h(
                StateBlock,
                { kind: 'empty', title: '未声明技能市场' },
                h('p', { className: 'bz-note' }, '该 Provider 未声明 skillMarket 能力。'),
              ),
          h(
            'div',
            { className: 'bz-subhead' },
            h('span', null, '记忆市场'),
            memoryOff
              ? h(
                  Tag,
                  { kind: memoryUndeclared ? 'disabled' : 'warn' },
                  memoryUndeclared ? '禁用：未声明 memoryMarket' : '暂不可用',
                )
              : h(Tag, { kind: 'readonly' }, 'memoryMarket'),
          ),
          memoryOff
            ? h(
                'p',
                { className: 'bz-note' },
                memoryUndeclared || memory === null || textOf(memory.message) === ''
                  ? '该 Provider 未声明 memoryMarket 能力，不以「暂无条目」冒充空态。'
                  : memory.message,
              )
            : rowList(memoryRows, '无匹配记忆条目'),
        )
      }

      var switches = enabledProviders.map(function (item) {
        var on = activeIds.indexOf(item.id) !== -1
        return h(
          'button',
          {
            key: item.id,
            type: 'button',
            role: 'switch',
            className: 'bz-switch-pill',
            'data-on': on === true ? 'true' : 'false',
            'aria-checked': on === true ? 'true' : 'false',
            'data-provider-switch': item.id,
            onClick: function () {
              var next = activeIds.slice()
              var at = next.indexOf(item.id)
              if (on === true) next.splice(at, 1)
              else next.push(item.id)
              void applyActive(next)
            },
          },
          h('span', { className: 'bz-switch-track', 'aria-hidden': 'true' }),
          h('span', null, item.displayName),
          h(Tag, { kind: on === true ? 'ok' : 'muted' }, on === true ? '已选' : '未选'),
        )
      })
      var cards = enabledProviders.map(function (provider) {
        var group = null
        for (var index = 0; index < domain.groups.length; index += 1) {
          if (domain.groups[index].providerId === provider.id) group = domain.groups[index]
        }
        var groupRows = rows.filter(function (row) {
          return row.providerId === provider.id
        })
        var groupActive = activeIds.indexOf(provider.id) !== -1
        var body =
          group !== null
            ? group.status === 'error'
              ? h(
                  'div',
                  { className: 'bz-inline-alert', role: 'alert' },
                  h(
                    'span',
                    null,
                    textOf(group.message) === '' ? '该分区读取失败。' : group.message,
                  ),
                  h('span', { className: 'bz-note' }, '　只有本分区报错：其他来源照常显示。'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bz-btn bz-btn--sm',
                      'data-retry-group': provider.id,
                      onClick: function () {
                        void retryGroup(provider.id)
                      },
                    },
                    '重试',
                  ),
                )
              : group.status === 'undeclared'
                ? h(
                    StateBlock,
                    { kind: 'empty', title: '未声明该能力域' },
                    h(
                      'p',
                      { className: 'bz-note' },
                      textOf(group.message) === ''
                        ? '该 provider 没有声明这个能力域。'
                        : group.message,
                    ),
                  )
                : tab === 'skill'
                  ? renderSkillSections(provider, group, groupRows, activeIds)
                  : groupRows.length === 0
                    ? h(
                        StateBlock,
                        { kind: 'empty', title: '本库无匹配条目' },
                        h('p', { className: 'bz-note' }, '筛选只在本分区内生效，不影响其他库。'),
                      )
                    : [
                        textOf(group.warning) !== ''
                          ? h(
                              'div',
                              { key: 'warn', className: 'bz-inline-alert', role: 'status' },
                              h('span', null, group.warning),
                            )
                          : null,
                      ].concat(
                        groupRows.map(function (row) {
                          return renderWorkbenchItem(row, provider, activeIds)
                        }),
                      )
            : groupActive
              ? h(
                  StateBlock,
                  { kind: 'loading', title: '正在读取…' },
                  h(Skeleton, { widths: ['w80', 'w60'] }),
                )
              : h(
                  StateBlock,
                  { kind: 'empty', title: '本会话未启用该来源' },
                  h(
                    'p',
                    { className: 'bz-note' },
                    '勾选上方来源开关即可加载这一家库的条目；未启用不等于没有内容。',
                  ),
                )
        return h(
          'section',
          {
            key: provider.id,
            className: 'bz-lib-card',
            'data-muted': activeIds.indexOf(provider.id) === -1 ? 'true' : 'false',
            'data-error': group !== null && group.status === 'error' ? 'true' : 'false',
          },
          h(
            'div',
            { className: 'bz-lib-card__head' },
            h(
              'span',
              { className: 'bz-lib-card__name' },
              h('span', null, provider.displayName),
              h('span', { className: 'bz-tag bz-mono', 'data-kind': 'muted' }, provider.id),
            ),
            activeIds.indexOf(provider.id) === -1
              ? h(Tag, { kind: 'disabled' }, '本会话未启用')
              : h(Tag, { kind: 'ok' }, '已启用'),
          ),
          h('div', { className: 'bz-lib-card__body' }, body),
        )
      })

      if (providers.phase === 'loading') {
        return h(
          'div',
          null,
          h(
            StateBlock,
            { kind: 'loading', title: '正在读取 Provider 集合…' },
            h(Skeleton, { widths: ['w60', 'w80'] }),
          ),
        )
      }
      if (providers.phase === 'error') {
        return h(
          'div',
          null,
          h(
            StateBlock,
            { kind: 'error', title: 'Provider 集合读取失败' },
            h('p', { className: 'bz-note' }, providers.message),
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
        )
      }
      if (enabledProviders.length === 0) {
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'bz-empty-box', role: 'status' },
            h('div', { className: 'bz-empty-box__title' }, '所有 Provider 都已在设置页禁用'),
            h(
              'div',
              { className: 'bz-empty-box__desc' },
              '会话面板与完整面板都不显示被禁用的来源；请前往「设置 → 集市」启用至少一个 Provider。',
            ),
            // 指路入口必须常驻：宿主不提供跳转回调（比如独立挂载的会话面板）时，
            // 退化成一句「自己去设置页」，而不是把这个按钮整个删掉——空态里没有
            // 下一步动作，用户就只能盯着「已被禁用」猜该怎么办。
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--primary bz-btn--sm',
                'data-goto-settings': 'true',
                onClick: function () {
                  if (typeof props.onGotoSettings === 'function') props.onGotoSettings()
                  else
                    showNotice('请在「设置 → 集市」里启用至少一个 Provider，再回到本会话选择来源。')
                },
              },
              typeof props.onGotoSettings === 'function' ? '前往设置页' : '怎么启用？',
            ),
          ),
          h(Notice, { notice: notice }),
        )
      }
      var tabDefs = [
        { id: 'expert', label: '专家' },
        { id: 'skill', label: '技能与记忆' },
        { id: 'connector', label: '连接器' },
      ]
      return h(
        'div',
        { className: 'bz-session-root' },
        h(
          'div',
          { className: 'bz-modal__nav' },
          h(
            'div',
            { className: 'bz-domain-tabs', role: 'tablist', 'aria-label': '工作台视图' },
            tabDefs.map(function (item) {
              return h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  className: 'bz-domain-tab',
                  'data-on': tab === item.id ? 'true' : 'false',
                  'aria-selected': tab === item.id ? 'true' : 'false',
                  'data-domain-tab': item.id,
                  onClick: function () {
                    setTab(item.id)
                  },
                },
                kindIcon(item.id, 13),
                h('span', null, item.label),
              )
            }),
          ),
          h(
            'div',
            { className: 'bz-provider-switches', role: 'group', 'aria-label': '本会话来源开关' },
            switches,
          ),
        ),
        h(
          'div',
          { className: 'bz-modal__toolbar' },
          h(
            'label',
            { className: 'bz-search-box' },
            searchIcon(13),
            h('input', {
              type: 'search',
              'data-modal-search': 'true',
              'aria-label': '在当前工作台筛选',
              placeholder:
                domain.hasMore === true ? '搜索全库或本地筛选（回车立即搜）…' : '在当前工作台筛选…',
              value: query,
              onChange: function (event) {
                var nextVal = event.target.value
                setQuery(nextVal)
                var current = domainRef.current
                var canRemote =
                  current.hasMore === true ||
                  textOf(current.remoteQuery) !== '' ||
                  textOf(current.remoteCategory) !== ''
                if (canRemote === true && (tab === 'expert' || tab === 'skill')) {
                  if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current)
                  searchTimerRef.current = setTimeout(function () {
                    searchTimerRef.current = null
                    void runRemoteSearch(nextVal, category)
                  }, 350)
                }
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter' && (tab === 'expert' || tab === 'skill')) {
                  if (searchTimerRef.current !== null) {
                    clearTimeout(searchTimerRef.current)
                    searchTimerRef.current = null
                  }
                  void runRemoteSearch(query, category)
                }
              },
            }),
          ),
          h(
            'div',
            { className: 'bz-domain-tabs', role: 'group', 'aria-label': '在当前工作台内分类筛选' },
            categoriesFor(tab, panel.data).map(function (item) {
              var on = category === item.id
              return h(
                'button',
                {
                  key: item.id === '' ? 'all' : item.id,
                  type: 'button',
                  className: 'bz-domain-tab',
                  'data-on': on === true ? 'true' : 'false',
                  'aria-pressed': on === true ? 'true' : 'false',
                  'data-category-tab': item.id,
                  onClick: function () {
                    setCategory(item.id)
                    var current = domainRef.current
                    var canRemote =
                      tab === 'expert' &&
                      item.id !== 'installed' &&
                      (current.hasMore === true || textOf(current.remoteCategory) !== '')
                    if (canRemote === true) {
                      void runRemoteSearch(query, item.id)
                    }
                  },
                },
                item.label,
              )
            }),
          ),
          h(Tag, { kind: 'muted' }, '会话隔离 · 关闭面板保留当前选择'),
        ),
        h(
          'div',
          { className: 'bz-modal__body' },
          activeIds.length === 0
            ? h(
                'div',
                { className: 'bz-empty-box', role: 'status' },
                h('div', { className: 'bz-empty-box__title' }, '尚未选择本会话的来源'),
                h(
                  'div',
                  { className: 'bz-empty-box__desc' },
                  '勾选上方任意来源即可展示对应能力，只影响当前会话。',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'bz-btn bz-btn--primary bz-btn--sm',
                    'data-enable-first': enabledProviders[0].id,
                    onClick: function () {
                      void applyActive([enabledProviders[0].id])
                    },
                  },
                  '启用 ' + enabledProviders[0].displayName,
                ),
              )
            : domain.phase === 'error'
              ? h(
                  StateBlock,
                  { kind: 'error', title: kindLabel(tab) + ' 读取失败' },
                  h('p', { className: 'bz-note' }, domain.message),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bz-btn bz-btn--sm',
                      onClick: function () {
                        setTick(function (previous) {
                          return previous + 1
                        })
                      },
                    },
                    '重试',
                  ),
                )
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'bz-lib-grid' },
                    cards.length === 0
                      ? h(
                          StateBlock,
                          { kind: 'loading', title: '正在读取…' },
                          h(Skeleton, { widths: ['w80', 'w60'] }),
                        )
                      : cards,
                  ),
                  domain.hasMore === true
                    ? h(
                        'div',
                        { className: 'bz-popover__more' },
                        h(
                          'span',
                          { className: 'bz-note' },
                          '已加载 ' +
                            String(rowsOf(tab, domain).length) +
                            (Number(domain.total) > 0 ? ' / ' + String(domain.total) : '') +
                            ' 项',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'bz-btn bz-btn--sm',
                            'data-load-more': tab,
                            disabled: loadingMore === true,
                            onClick: function () {
                              void loadMore()
                            },
                          },
                          loadingMore === true ? '加载中…' : '加载更多',
                        ),
                      )
                    : null,
                ),
        ),
        h(Notice, { notice: notice }),
      )
    }

    /**
     * 完整面板外壳。hook 全部在顶层：`if (props.open !== true) return null`
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
          className: 'bz-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '能力集市 · 完整工作台',
        },
        h(
          'div',
          { className: 'bz-modal__head' },
          h(
            'div',
            null,
            h('h3', { className: 'bz-modal__title' }, '能力集市 · 完整工作台'),
            h(
              'p',
              { className: 'bz-modal__sub' },
              '只列出设置页已启用的 Provider：选专家、装技能与记忆、控制本会话连接器。',
            ),
          ),
          h(
            'div',
            { className: 'bz-modal__head-right' },
            h(
              'button',
              {
                type: 'button',
                className: 'bz-icon-close',
                'aria-label': '关闭完整面板',
                onClick: function () {
                  if (typeof props.onClose === 'function') props.onClose()
                },
              },
              closeIcon(),
            ),
          ),
        ),
        h(
          'div',
          { ref: panelRef, className: 'bz-modal__shell', tabIndex: -1 },
          ready === true
            ? h(SessionPanel, {
                sessionId: props.sessionId,
                initialTab: props.initialTab,
                onStateChange: props.onStateChange,
                onGotoSettings: props.onGotoSettings,
              })
            : null,
        ),
        h(
          'div',
          { className: 'bz-modal__foot' },
          h(
            'span',
            { className: 'bz-note' },
            '提示：要彻底启用/禁用某个 Provider，或配置账号与凭据，请前往「设置 → 集市」。',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              onClick: function () {
                if (typeof props.onClose === 'function') props.onClose()
              },
            },
            '关闭（Esc）',
          ),
        ),
      )

      var scrim = h(
        'div',
        {
          className: 'bz-overlay',
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
            '[' + PACKAGE_ID + '] market dialog crashed; the composer entry stays mounted:',
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

    /**
     * 上浮面板（纯展示）：来源过滤 + 分类标签 + 常用/推荐两段 + 底置搜索栏。
     *
     * 刻意不持有任何 hook：它的输入全部来自 ComposerEntry（数据、筛选、回调都在那边），
     * 于是「面板长什么样」与「数据怎么来」互不纠缠，面板也不会因为自己被重挂而重复取数。
     */
    function MarketPopover(props) {
      var kind = props.kind
      var categories =
        Array.isArray(props.categories) && props.categories.length > 0
          ? props.categories
          : CATEGORIES[kind]
      var rows = props.rows
      var groups = Array.isArray(props.groups) ? props.groups : []
      var errorGroups = groups.filter(function (g) {
        return g !== null && g !== undefined && g.status === 'error'
      })
      var warningGroups = groups.filter(function (g) {
        return g !== null && g !== undefined && textOf(g.warning) !== ''
      })
      var disabledIds = props.disabledConnectors === undefined ? [] : props.disabledConnectors
      // 当数据是按服务端关键词/分类拉回来时，不再因本地字段差异错杀服务端命中项；
      // 本地即时过滤仅在未发起服务端筛选或继续细化时生效。
      var localCategory =
        textOf(props.remoteCategory) !== '' && props.remoteCategory === props.category
          ? ''
          : props.category
      var filtered = filterRows(kind, rows, props.query, localCategory, disabledIds)
      var recentKeys = recentKeysOf(kind)
      var recentRows = []
      var restRows = []
      for (var index = 0; index < filtered.length; index += 1) {
        var key = itemKey(filtered[index].providerId, filtered[index].id)
        if (props.query === '' && recentKeys.indexOf(key) !== -1) recentRows.push(filtered[index])
        else restRows.push(filtered[index])
      }
      var showLibrary = props.activeCount > 1
      var noProviders = props.providers.length === 0
      var noActive = props.activeCount === 0

      /** providerId → 显示名：冲突徽标要写清「谁装过」，不能只写 id。 */
      function displayNameOf(providerId) {
        for (var p = 0; p < props.providers.length; p += 1) {
          if (props.providers[p].id === providerId) return props.providers[p].displayName
        }
        return providerId
      }

      /** 与工作台同一判据：`installedBy` 指向别家才算冲突，自家装的属于「已安装」。 */
      function conflictOwnerOf(row) {
        var owner =
          row.installedBy === null || row.installedBy === undefined ? '' : textOf(row.installedBy)
        if (owner === '' || owner === row.providerId) return ''
        return displayNameOf(owner)
      }

      /** 上浮面板与工作台共用的行参数：库是否被选中、冲突归属、复制片段。 */
      function rowProps(row) {
        return {
          kind: kind,
          row: row,
          showLibrary: showLibrary,
          selected:
            props.currentExpert !== null && props.currentExpert !== undefined
              ? isExpertSelected(props.currentExpert, row)
              : props.selectedKey === itemKey(row.providerId, row.id),
          busy: props.busy,
          providerActive: props.activeIds.indexOf(row.providerId) !== -1,
          conflictOwner: conflictOwnerOf(row),
          sessionDisabled: disabledIds.indexOf(row.id) !== -1,
          onCopyConfig: props.onCopyConfig,
        }
      }

      var alerts = []
      for (var e = 0; e < errorGroups.length; e += 1) {
        var eg = errorGroups[e]
        alerts.push(
          h(
            'div',
            { key: 'err-' + eg.providerId, className: 'bz-inline-alert', role: 'alert' },
            h(
              'span',
              null,
              displayNameOf(eg.providerId) +
                '：' +
                (textOf(eg.message) === '' ? '数据源读取失败' : eg.message),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--sm',
                'data-popover-retry': kind,
                onClick: function () {
                  props.onRetry()
                },
              },
              '重试',
            ),
          ),
        )
      }
      for (var w = 0; w < warningGroups.length; w += 1) {
        var wg = warningGroups[w]
        alerts.push(
          h(
            'div',
            { key: 'warn-' + wg.providerId, className: 'bz-inline-alert', role: 'status' },
            h('span', null, wg.warning),
          ),
        )
      }

      // 六态优先序：没启用的库 → 没选来源 → 读取中 → 出错（含全组报错）→ 空集 → 列表。
      var body
      if (noProviders === true) {
        body = h(
          'div',
          { className: 'bz-empty-box', role: 'status' },
          h('div', { className: 'bz-empty-box__title' }, '暂无已启用的 Provider'),
          h(
            'div',
            { className: 'bz-empty-box__desc' },
            '全部 Provider 已在设置页禁用，因此会话面板不显示任何来源；请前往设置页启用至少一个。',
          ),
        )
      } else if (noActive === true) {
        body = h(
          'div',
          { className: 'bz-empty-box', role: 'status' },
          h('div', { className: 'bz-empty-box__title' }, '尚未选择会话来源'),
          h(
            'div',
            { className: 'bz-empty-box__desc' },
            '勾选上方任意来源即可展示对应能力，只影响当前会话。',
          ),
        )
      } else if (props.phase === 'loading') {
        body = [0, 1, 2, 3].map(function (i) {
          return h(
            'div',
            { key: 'skel-' + i, className: 'bz-skel-row', 'aria-busy': 'true' },
            h('div', { className: 'bz-skel-circle' }),
            h('div', { className: 'bz-skel-bar', style: { width: i % 2 === 0 ? '26%' : '20%' } }),
            h('div', { className: 'bz-skel-bar', style: { width: i % 2 === 0 ? '54%' : '46%' } }),
          )
        })
      } else if (props.phase === 'error') {
        body = h(
          StateBlock,
          { kind: 'error', title: kindLabel(kind) + '读取失败' },
          h('p', { className: 'bz-note' }, props.message),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              'data-popover-retry': kind,
              onClick: function () {
                props.onRetry()
              },
            },
            '重试',
          ),
        )
      } else if (rows.length === 0 && errorGroups.length > 0) {
        body = h(
          StateBlock,
          { kind: 'error', title: kindLabel(kind) + '读取失败' },
          h(
            'p',
            { className: 'bz-note' },
            textOf(errorGroups[0].message) === '' ? '数据源返回错误。' : errorGroups[0].message,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-btn bz-btn--sm',
              'data-popover-retry': kind,
              onClick: function () {
                props.onRetry()
              },
            },
            '重试',
          ),
        )
      } else if (filtered.length === 0) {
        body = h(
          'div',
          { className: 'bz-empty-box', role: 'status' },
          h('div', { className: 'bz-empty-box__title' }, '未找到匹配的' + kindLabel(kind)),
          h(
            'div',
            { className: 'bz-empty-box__desc' },
            '暂无与「' + (props.query === '' ? props.category : props.query) + '」匹配的条目。',
          ),
          h(
            'div',
            { className: 'bz-row', style: { justifyContent: 'center' } },
            props.hasMore === true &&
              props.query !== '' &&
              typeof props.onSearchSubmit === 'function'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'bz-btn bz-btn--primary bz-btn--sm',
                    'data-search-remote': kind,
                    onClick: function () {
                      props.onSearchSubmit()
                    },
                  },
                  '搜索全库',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'bz-btn bz-btn--sm',
                'data-reset-filters': kind,
                onClick: function () {
                  props.onReset()
                },
              },
              '清除筛选',
            ),
          ),
        )
      } else {
        var sections = alerts.slice()
        // 行组件的公共属性来自 `rowProps`，逐行只差回调闭包里的那一条 row。
        var renderRow = function (keyPrefix, row) {
          var shared = rowProps(row)
          return h(MarketRow, {
            key: keyPrefix + itemKey(row.providerId, row.id),
            kind: shared.kind,
            row: shared.row,
            showLibrary: shared.showLibrary,
            selected: shared.selected,
            busy: shared.busy,
            providerActive: shared.providerActive,
            conflictOwner: shared.conflictOwner,
            sessionDisabled: shared.sessionDisabled,
            onCopyConfig: shared.onCopyConfig,
            onPick: function () {
              props.onPick(row)
            },
            onClearExpert: props.onClearExpert,
            onInstall: function (force) {
              props.onInstall(row, force)
            },
            onToggleConnector: function () {
              props.onToggleConnector(row)
            },
            onAuthorize: function () {
              props.onAuthorize(row)
            },
          })
        }
        if (recentRows.length > 0) {
          sections.push(
            h(
              'div',
              { key: 'recent-title', className: 'bz-group-title' },
              h('span', null, '常用' + kindLabel(kind) + ' (' + String(recentRows.length) + ')'),
            ),
          )
          for (var r = 0; r < recentRows.length; r += 1) {
            sections.push(renderRow('r-', recentRows[r]))
          }
        }
        var totalSuffix =
          Number(props.total) > restRows.length && props.hasMore === true
            ? ' (' + String(restRows.length) + ' / ' + String(props.total) + ')'
            : ' (' + String(restRows.length) + ')'
        var restTitle =
          props.query !== ''
            ? '匹配结果' + totalSuffix
            : (kind === 'expert' ? '推荐专家' : kind === 'skill' ? '市场与记忆' : '更多连接器') +
              totalSuffix
        if (restRows.length > 0) {
          sections.push(
            h(
              'div',
              { key: 'rest-title', className: 'bz-group-title' },
              h('span', null, restTitle),
            ),
          )
          for (var s = 0; s < restRows.length; s += 1) {
            sections.push(renderRow('a-', restRows[s]))
          }
        }
        if (props.hasMore === true && typeof props.onLoadMore === 'function') {
          sections.push(
            h(
              'div',
              { key: 'load-more', className: 'bz-popover__more' },
              h(
                'span',
                { className: 'bz-note' },
                '已展示 ' +
                  String(rows.length) +
                  (Number(props.total) > 0 ? ' / ' + String(props.total) : '') +
                  ' 项',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--sm',
                  'data-popover-more': kind,
                  disabled: props.loadingMore === true,
                  onClick: function () {
                    props.onLoadMore()
                  },
                },
                props.loadingMore === true ? '加载中…' : '加载更多',
              ),
            ),
          )
        }
        sections.push(
          h(
            'button',
            {
              key: 'view-all',
              type: 'button',
              className: 'bz-view-all-link',
              'data-open-full': kind,
              onClick: function () {
                props.onOpenFull()
              },
            },
            '查看全部与多来源对比 ›',
          ),
        )
        body = sections
      }
      var sourcePills = props.providers.map(function (provider) {
        var on = props.activeIds.indexOf(provider.id) !== -1
        var hasErr = errorGroups.some(function (g) {
          return g.providerId === provider.id
        })
        return h(
          'button',
          {
            key: provider.id,
            type: 'button',
            className: 'bz-source-pill',
            'data-on': on === true ? 'true' : 'false',
            'data-error': hasErr === true ? 'true' : 'false',
            'data-action': 'toggle-provider',
            'data-provider': provider.id,
            'aria-pressed': on === true ? 'true' : 'false',
            onClick: function () {
              props.onToggleProvider(provider)
            },
          },
          h('span', { className: 'bz-source-dot', 'aria-hidden': 'true' }),
          h('span', null, provider.displayName),
          h('span', null, on === true ? '已选' : '未选'),
        )
      })
      var currentExpertBar =
        kind === 'expert' && props.currentExpert !== null && props.currentExpert !== undefined
          ? h(
              'div',
              { className: 'bz-popover__current' },
              h(
                'div',
                { className: 'bz-popover__current-main' },
                h(Tag, { kind: 'info' }, '当前专家'),
                h(
                  'span',
                  { className: 'bz-popover__current-name' },
                  textOf(
                    props.currentExpert.displayName === undefined
                      ? props.currentExpert.id
                      : props.currentExpert.displayName,
                  ),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bz-btn bz-btn--sm',
                  'data-clear-current-expert': 'true',
                  onClick: function () {
                    props.onClearExpert()
                  },
                },
                '退出专家',
              ),
            )
          : null
      return h(
        'div',
        { className: 'bz-popover', role: 'region', 'aria-label': '能力集市快捷面板' },
        currentExpertBar,
        h(
          'div',
          { className: 'bz-popover__filters' },
          h(
            'div',
            { className: 'bz-filter-cluster' },
            h('span', { className: 'bz-filter-label' }, '来源'),
            sourcePills.length === 0 ? h(Tag, { kind: 'muted' }, '无已启用来源') : sourcePills,
          ),
          h(
            'div',
            { className: 'bz-filter-cluster', role: 'group', 'aria-label': '分类筛选' },
            categories.map(function (chip) {
              return h(
                'button',
                {
                  key: 'cat-' + chip.id,
                  type: 'button',
                  className: 'bz-cat-chip',
                  'data-on': props.category === chip.id ? 'true' : 'false',
                  'aria-pressed': props.category === chip.id ? 'true' : 'false',
                  'data-category': chip.id,
                  onClick: function () {
                    props.onCategory(chip.id)
                  },
                },
                chip.label,
              )
            }),
          ),
        ),
        h('div', { className: 'bz-popover__list', role: 'list' }, body),
        h(
          'div',
          { className: 'bz-popover__searchbar' },
          h('span', { className: 'bz-popover__searchicon' }, searchIcon(13)),
          h('input', {
            type: 'search',
            className: 'bz-popover__searchinput',
            'data-popover-search': kind,
            'aria-label': SEARCH_PLACEHOLDER[kind],
            placeholder: SEARCH_PLACEHOLDER[kind],
            value: props.query,
            onChange: function (event) {
              props.onQuery(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && typeof props.onSearchSubmit === 'function') {
                props.onSearchSubmit()
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'bz-popover__fullbtn',
              'data-open-full': 'bar',
              onClick: function () {
                props.onOpenFull()
              },
            },
            gridIcon(12),
            h('span', null, '完整面板'),
          ),
        ),
      )
    }

    /**
     * 输入栏入口：三个单行胶囊（专家 / 技能 / 连接器）+ 完整面板入口。
     *
     * 数据全部在组件内取一次并缓存：切换分类只是换一份已取到手的行，不再发请求。
     * 唯一的例外是「本会话来源开关」——它写服务端，写完整份重取。
     */
    function ComposerEntry(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var fullTabPair = React.useState('expert')
      var fullTab = fullTabPair[0]
      var setFullTab = fullTabPair[1]
      var kindPair = React.useState(null)
      var kind = kindPair[0]
      var setKind = kindPair[1]
      var providersPair = React.useState({ phase: 'loading', items: [], activeProviders: [] })
      var providers = providersPair[0]
      var setProviders = providersPair[1]
      var panelPair = React.useState(null)
      var panel = panelPair[0]
      var setPanel = panelPair[1]
      var domainsPair = React.useState({ expert: null, skill: null, connector: null })
      var domains = domainsPair[0]
      var setDomains = domainsPair[1]
      var queryPair = React.useState({ expert: '', skill: '', connector: '' })
      var queryMap = queryPair[0]
      var setQueryMap = queryPair[1]
      var categoryPair = React.useState({ expert: '', skill: '', connector: '' })
      var categoryMap = categoryPair[0]
      var setCategoryMap = categoryPair[1]
      var disabledPair = React.useState([])
      var disabledConnectors = disabledPair[0]
      var setDisabledConnectors = disabledPair[1]
      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var noticePair = React.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var tickPair = React.useState(0)
      var tick = tickPair[0]
      var setTick = tickPair[1]
      var loadingMorePair = React.useState(false)
      var loadingMore = loadingMorePair[0]
      var setLoadingMore = loadingMorePair[1]
      var anchorPair = React.useState(null)
      var anchor = anchorPair[0]
      var setAnchor = anchorPair[1]
      var hostRef = React.useRef(null)
      var popoverRef = React.useRef(null)
      var autoActivatedRef = React.useRef(false)
      var searchTimerRef = React.useRef(null)
      var noticeTimerRef = React.useRef(null)
      var domainsRef = React.useRef(domains)
      domainsRef.current = domains
      var queryRef = React.useRef(queryMap)
      queryRef.current = queryMap
      var categoryRef = React.useRef(categoryMap)
      categoryRef.current = categoryMap

      var showNotice = React.useCallback(function (text, kindOfNotice) {
        if (noticeTimerRef.current !== null) {
          clearTimeout(noticeTimerRef.current)
          noticeTimerRef.current = null
        }
        setNotice({ text: text, kind: kindOfNotice === undefined ? 'ok' : kindOfNotice })
        var timer = setTimeout(function () {
          noticeTimerRef.current = null
          setNotice(null)
        }, 3500)
        if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') {
          timer.unref()
        }
        noticeTimerRef.current = timer
      }, [])

      var applyActive = React.useCallback(
        async function (nextIds) {
          try {
            await postJson(ROUTES.providersActive, {
              sessionId: props.sessionId,
              activeProviders: nextIds,
            })
            // 与工作台同一处理：本地先回填，否则第二次点击仍按旧集算 next，
            // 表现成「关不掉」。
            setProviders(function (previous) {
              return {
                phase: previous.phase,
                items: previous.items,
                message: previous.message,
                activeProviders: nextIds.slice(),
              }
            })
            setDomains({ expert: null, skill: null, connector: null })
            setTick(function (previous) {
              return previous + 1
            })
          } catch (error) {
            showNotice('切换失败：' + messageOf(error), 'error')
          }
        },
        [props.sessionId, showNotice],
      )

      var loadProviders = React.useCallback(
        async function () {
          try {
            var body = await getJson(ROUTES.providers + queryOf({ sessionId: props.sessionId }))
            var items = Array.isArray(body.items) ? body.items : []
            var activeList = Array.isArray(body.activeProviders) ? body.activeProviders : []
            setProviders({
              phase: 'ready',
              items: items,
              activeProviders: activeList,
            })
            // 新会话首次挂载（服务端明确标记 initialized===false 且有效 sessionId 已就绪）：
            // 自动激活设置页已启用的 Provider，让用户点开胶囊即可直接浏览与选用。
            if (
              body.initialized === false &&
              activeList.length === 0 &&
              textOf(props.sessionId) !== '' &&
              autoActivatedRef.current !== true
            ) {
              var autoIds = items
                .filter(function (item) {
                  return item.enabled !== false
                })
                .map(function (item) {
                  return item.id
                })
              if (autoIds.length > 0) {
                autoActivatedRef.current = true
                void applyActive(autoIds)
              }
            }
          } catch (error) {
            setProviders({ phase: 'error', items: [], activeProviders: [] })
            void error
          }
        },
        [applyActive, props.sessionId],
      )

      var loadPanel = React.useCallback(
        async function () {
          try {
            var body = await getJson(ROUTES.state + queryOf({ sessionId: props.sessionId }))
            setPanel(body.state === undefined ? body : body.state)
          } catch (error) {
            setPanel(null)
            void error
          }
        },
        [props.sessionId],
      )

      var loadDomain = React.useCallback(
        async function (kindOfDomain, options) {
          var ids = providers.phase === 'ready' ? providers.activeProviders.slice() : []
          if (ids.length === 0) {
            setDomains(function (previous) {
              var next = Object.assign({}, previous)
              next[kindOfDomain] = {
                phase: 'ready',
                groups: [],
                hasMore: false,
                page: 1,
                total: 0,
                message: null,
              }
              return next
            })
            return
          }
          var opts = options === undefined || options === null ? {} : options
          var append = opts.append === true
          if (append !== true) {
            setDomains(function (previous) {
              var next = Object.assign({}, previous)
              next[kindOfDomain] = {
                phase: 'loading',
                groups: [],
                hasMore: false,
                page: 1,
                total: 0,
                message: null,
              }
              return next
            })
          }
          try {
            var result = await fetchDomain(kindOfDomain, props.sessionId, ids, opts)
            setDomains(function (previous) {
              var next = Object.assign({}, previous)
              if (
                append === true &&
                previous[kindOfDomain] !== null &&
                previous[kindOfDomain] !== undefined
              ) {
                next[kindOfDomain] = Object.assign({}, result, {
                  groups: mergeDomainGroups(previous[kindOfDomain].groups, result.groups),
                })
              } else {
                next[kindOfDomain] = result
              }
              return next
            })
            var first = result.groups.length > 0 ? result.groups[0] : null
            if (kindOfDomain === 'connector' && first !== null && Array.isArray(first.disabled)) {
              setDisabledConnectors(first.disabled.slice())
            }
          } catch (error) {
            if (append === true) {
              showNotice('加载更多失败：' + messageOf(error), 'error')
            } else {
              setDomains(function (previous) {
                var next = Object.assign({}, previous)
                next[kindOfDomain] = {
                  phase: 'error',
                  groups: [],
                  hasMore: false,
                  page: 1,
                  total: 0,
                  message: messageOf(error),
                }
                return next
              })
            }
          }
        },
        [props.sessionId, providers.activeProviders, providers.phase, showNotice],
      )

      var loadMoreFor = React.useCallback(
        async function (kindOfDomain) {
          var current = domainsRef.current[kindOfDomain]
          if (
            current === null ||
            current === undefined ||
            current.hasMore !== true ||
            loadingMore === true
          )
            return
          setLoadingMore(true)
          try {
            await loadDomain(kindOfDomain, {
              append: true,
              page: (Number(current.page) || 1) + 1,
              query: textOf(current.remoteQuery),
              categoryId: textOf(current.remoteCategory),
            })
          } finally {
            setLoadingMore(false)
          }
        },
        [loadDomain, loadingMore],
      )

      React.useEffect(
        function () {
          autoActivatedRef.current = false
        },
        [props.sessionId],
      )

      React.useEffect(function () {
        return function () {
          if (searchTimerRef.current !== null) {
            clearTimeout(searchTimerRef.current)
            searchTimerRef.current = null
          }
          if (noticeTimerRef.current !== null) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = null
          }
        }
      }, [])

      React.useEffect(
        function () {
          void loadProviders()
          void loadPanel()
        },
        [loadPanel, loadProviders, tick],
      )

      React.useEffect(
        function () {
          if (kind === null) return
          if (domains[kind] !== null) return
          void loadDomain(kind)
        },
        [domains, kind, loadDomain],
      )

      // 上浮面板的锚点测量、Esc 与点击外部收起（仅在真实浏览器 DOM 下启用）。
      React.useEffect(
        function () {
          if (kind === null) {
            setAnchor(null)
            return undefined
          }
          if (
            typeof window === 'undefined' ||
            window === null ||
            typeof document === 'undefined' ||
            document === null
          ) {
            return undefined
          }
          var updateAnchor = function () {
            var node = hostRef.current
            if (
              node === null ||
              node === undefined ||
              typeof node.getBoundingClientRect !== 'function'
            ) {
              setAnchor(null)
              return
            }
            var rect = node.getBoundingClientRect()
            var vw = Number(window.innerWidth) || 1024
            var vh = Number(window.innerHeight) || 768
            var popWidth = Math.min(680, Math.max(280, vw - 24))
            // 略微向左居中对齐于整个输入栏，避免贴着右侧偏斜。
            var left = Math.max(12, Math.min(rect.left - 120, vw - popWidth - 12))
            var bottom = Math.max(12, vh - rect.top + 10)
            setAnchor({ left: Math.round(left), bottom: Math.round(bottom) })
          }
          updateAnchor()
          var onKeyDown = function (event) {
            if (event.key === 'Escape') setKind(null)
          }
          var onMouseDown = function (event) {
            var target = event.target
            var hostNode = hostRef.current
            var popNode = popoverRef.current
            if (
              hostNode !== null &&
              typeof hostNode.contains === 'function' &&
              hostNode.contains(target)
            )
              return
            if (
              popNode !== null &&
              typeof popNode.contains === 'function' &&
              popNode.contains(target)
            )
              return
            setKind(null)
          }
          if (typeof window.addEventListener === 'function') {
            window.addEventListener('resize', updateAnchor)
            window.addEventListener('scroll', updateAnchor, true)
          }
          if (typeof document.addEventListener === 'function') {
            document.addEventListener('keydown', onKeyDown)
            document.addEventListener('mousedown', onMouseDown)
          }
          return function () {
            if (typeof window.removeEventListener === 'function') {
              window.removeEventListener('resize', updateAnchor)
              window.removeEventListener('scroll', updateAnchor, true)
            }
            if (typeof document.removeEventListener === 'function') {
              document.removeEventListener('keydown', onKeyDown)
              document.removeEventListener('mousedown', onMouseDown)
            }
          }
        },
        [kind],
      )

      var pickExpert = React.useCallback(
        async function (row) {
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.select, {
              sessionId: props.sessionId,
              expertId: row.id,
              providerId: row.providerId,
            })
            rememberRecent('expert', row)
            showNotice('已选用 ' + row.providerName + ' · ' + row.name + '（下一条消息生效）')
            setDomains({ expert: null, skill: null, connector: null })
            await loadPanel()
          } catch (error) {
            showNotice('选择失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [loadPanel, props.sessionId, showNotice],
      )

      var installSkill = React.useCallback(
        async function (row, force) {
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.skillInstall, {
              sessionId: props.sessionId,
              providerId: row.providerId,
              skillId: textOf(row.installId) || row.id,
              force: force === true,
            })
            rememberRecent('skill', row)
            showNotice((force === true ? '已重装' : '已安装') + '技能 ' + row.id + '。')
            await loadDomain('skill')
          } catch (error) {
            showNotice('安装失败：' + messageOf(error), 'error')
            await loadDomain('skill')
          } finally {
            setBusy(null)
          }
        },
        [loadDomain, props.sessionId, showNotice],
      )

      var toggleConnector = React.useCallback(
        async function (row) {
          var next = disabledConnectors.slice()
          var at = next.indexOf(row.id)
          if (at === -1) next.push(row.id)
          else next.splice(at, 1)
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.connectorsSession, {
              sessionId: props.sessionId,
              disabled: next,
            })
            setDisabledConnectors(next)
            rememberRecent('connector', row)
            showNotice(at === -1 ? '已在本会话停用连接器。' : '已在本会话启用连接器。')
          } catch (error) {
            showNotice('切换失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [disabledConnectors, props.sessionId, showNotice],
      )

      var authorizeConnector = React.useCallback(
        async function (row) {
          setBusy(itemKey(row.providerId, row.id))
          try {
            await postJson(ROUTES.providerConnectorAction(row.providerId), {
              providerId: row.providerId,
              action: 'authorize',
              id: row.id,
              sessionId: props.sessionId,
            })
            rememberRecent('connector', row)
            showNotice('已发起授权，请按提示完成。')
            await loadDomain('connector')
          } catch (error) {
            showNotice('授权失败：' + messageOf(error), 'error')
          } finally {
            setBusy(null)
          }
        },
        [loadDomain, props.sessionId, showNotice],
      )

      var copyConnectorConfig = React.useCallback(
        async function (row) {
          try {
            var body = await postJson(ROUTES.providerConnectorAction(row.providerId), {
              providerId: row.providerId,
              action: 'copy-config',
              id: row.id,
              sessionId: props.sessionId,
            })
            var snippet = textOf(body.text) === '' ? textOf(body.config) : body.text
            var copied = await copyText(snippet)
            showNotice(
              copied === true
                ? '配置片段已复制（只产出文本，不改宿主配置）'
                : '配置片段：' + snippet,
            )
          } catch (error) {
            showNotice('复制失败：' + messageOf(error), 'error')
          }
        },
        [props.sessionId, showNotice],
      )

      var clearExpert = React.useCallback(
        async function () {
          try {
            await postJson(ROUTES.off, { sessionId: props.sessionId })
            showNotice('已退出当前专家，恢复默认助手。')
            setDomains({ expert: null, skill: null, connector: null })
            await loadPanel()
          } catch (error) {
            showNotice('操作失败：' + messageOf(error), 'error')
          }
        },
        [loadPanel, props.sessionId, showNotice],
      )

      var enabledProviders =
        providers.phase === 'ready'
          ? providers.items.filter(function (item) {
              return item.enabled !== false
            })
          : []
      var activeIds = providers.phase === 'ready' ? providers.activeProviders.slice() : []
      var experts = panel !== null && Array.isArray(panel.experts) ? panel.experts : []
      var currentExpert =
        panel !== null && panel.expert !== null && panel.expert !== undefined ? panel.expert : null
      var selectedKey =
        currentExpert !== null ? itemKey(currentExpert.providerId, currentExpert.id) : null
      var activeDomain = kind === null ? null : domains[kind]
      var skillRows = rowsOf('skill', domains.skill)
      var installedSkillCount = skillRows.filter(function (row) {
        return row.installed === true
      }).length
      var connectorRows = rowsOf('connector', domains.connector)
      var connectedCount = connectorRows.filter(function (row) {
        return row.connected === true && disabledConnectors.indexOf(row.id) === -1
      }).length
      var expertSub =
        experts.length === 0
          ? ''
          : experts.length === 1
            ? textOf(experts[0].displayName === undefined ? experts[0].id : experts[0].displayName)
            : String(experts.length)
      var pillDefs = [
        { id: 'expert', label: '专家', sub: expertSub, count: experts.length },
        {
          id: 'skill',
          label: '技能',
          sub: installedSkillCount > 0 ? String(installedSkillCount) : '',
          count: installedSkillCount,
        },
        {
          id: 'connector',
          label: '连接器',
          sub: connectedCount > 0 ? String(connectedCount) : '',
          count: connectedCount,
        },
      ]
      var pills = pillDefs.map(function (item) {
        return h(
          'button',
          {
            key: item.id,
            type: 'button',
            className: 'bz-pill-btn',
            'data-kind': item.id,
            'data-active': kind === item.id ? 'true' : 'false',
            'data-has-selection': item.count > 0 ? 'true' : 'false',
            'aria-expanded': kind === item.id ? 'true' : 'false',
            'aria-label': item.label + '集市',
            onClick: function () {
              var next = kind === item.id ? null : item.id
              setKind(next)
              if (next !== null)
                setCategoryMap(function (previous) {
                  var map = Object.assign({}, previous)
                  map[next] = ''
                  return map
                })
            },
          },
          h('span', { className: 'bz-pill-btn__icon' }, kindIcon(item.id, 14)),
          h('span', null, item.label),
          item.sub === '' ? null : h('span', { className: 'bz-pill-btn__sub' }, '· ' + item.sub),
          h('span', { className: 'bz-pill-btn__chev' }, chevronIcon(10)),
        )
      })
      var popover =
        kind === null
          ? null
          : h(MarketPopover, {
              kind: kind,
              categories: categoriesFor(kind, panel),
              groups: activeDomain === null ? [] : activeDomain.groups,
              rows: rowsOf(kind, activeDomain),
              phase: activeDomain === null ? 'loading' : activeDomain.phase,
              message: activeDomain === null ? null : activeDomain.message,
              hasMore: activeDomain !== null && activeDomain.hasMore === true,
              total: activeDomain === null ? 0 : activeDomain.total,
              remoteCategory: activeDomain === null ? '' : textOf(activeDomain.remoteCategory),
              loadingMore: loadingMore,
              currentExpert: currentExpert,
              query: queryMap[kind] === undefined ? '' : queryMap[kind],
              category: categoryMap[kind] === undefined ? '' : categoryMap[kind],
              providers: enabledProviders,
              activeIds: activeIds,
              activeCount: activeIds.length,
              selectedKey: selectedKey,
              busy: busy,
              disabledConnectors: disabledConnectors,
              onQuery: function (value) {
                var currentKind = kind
                setQueryMap(function (previous) {
                  var map = Object.assign({}, previous)
                  map[currentKind] = value
                  return map
                })
                var current = domainsRef.current[currentKind]
                var canRemote =
                  current !== null &&
                  current !== undefined &&
                  (current.hasMore === true ||
                    textOf(current.remoteQuery) !== '' ||
                    textOf(current.remoteCategory) !== '')
                if (canRemote === true && (currentKind === 'expert' || currentKind === 'skill')) {
                  if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current)
                  searchTimerRef.current = setTimeout(function () {
                    searchTimerRef.current = null
                    void loadDomain(currentKind, {
                      query: value,
                      categoryId: textOf(categoryRef.current[currentKind]),
                      page: 1,
                    })
                  }, 350)
                }
              },
              onSearchSubmit: function () {
                var currentKind = kind
                if (currentKind === null) return
                if (searchTimerRef.current !== null) {
                  clearTimeout(searchTimerRef.current)
                  searchTimerRef.current = null
                }
                void loadDomain(currentKind, {
                  query: textOf(queryRef.current[currentKind]),
                  categoryId: textOf(categoryRef.current[currentKind]),
                  page: 1,
                })
              },
              onCategory: function (value) {
                var currentKind = kind
                setCategoryMap(function (previous) {
                  var map = Object.assign({}, previous)
                  map[currentKind] = value
                  return map
                })
                var current = domainsRef.current[currentKind]
                var canRemote =
                  currentKind === 'expert' &&
                  value !== 'installed' &&
                  current !== null &&
                  current !== undefined &&
                  (current.hasMore === true || textOf(current.remoteCategory) !== '')
                if (canRemote === true) {
                  void loadDomain(currentKind, {
                    query: textOf(queryRef.current[currentKind]),
                    categoryId: value,
                    page: 1,
                  })
                }
              },
              onReset: function () {
                var currentKind = kind
                setQueryMap(function (previous) {
                  var map = Object.assign({}, previous)
                  map[currentKind] = ''
                  return map
                })
                setCategoryMap(function (previous) {
                  var map = Object.assign({}, previous)
                  map[currentKind] = ''
                  return map
                })
                var current = domainsRef.current[currentKind]
                if (
                  current !== null &&
                  current !== undefined &&
                  (textOf(current.remoteQuery) !== '' || textOf(current.remoteCategory) !== '')
                ) {
                  void loadDomain(currentKind, { query: '', categoryId: '', page: 1 })
                }
              },
              onRetry: function () {
                void loadDomain(kind, {
                  query: textOf(queryRef.current[kind]),
                  categoryId: textOf(categoryRef.current[kind]),
                  page: 1,
                })
              },
              onLoadMore: function () {
                void loadMoreFor(kind)
              },
              onToggleProvider: function (provider) {
                var next = activeIds.slice()
                var at = next.indexOf(provider.id)
                if (at === -1) next.push(provider.id)
                else next.splice(at, 1)
                void applyActive(next)
              },
              onPick: function (row) {
                void pickExpert(row)
              },
              onClearExpert: function () {
                void clearExpert()
              },
              onInstall: function (row, force) {
                void installSkill(row, force)
              },
              onToggleConnector: function (row) {
                void toggleConnector(row)
              },
              onAuthorize: function (row) {
                void authorizeConnector(row)
              },
              onCopyConfig: function (row) {
                void copyConnectorConfig(row)
              },
              onOpenFull: function () {
                setFullTab(kind === null ? 'expert' : kind)
                setOpen(true)
                setKind(null)
              },
            })
      var popoverNode = null
      if (popover !== null) {
        if (
          anchor !== null &&
          typeof document !== 'undefined' &&
          document !== null &&
          document.body !== null &&
          document.body !== undefined &&
          typeof createPortal === 'function'
        ) {
          var floating = h(
            'div',
            {
              ref: popoverRef,
              className: 'bz-popover-portal',
              style: { left: String(anchor.left) + 'px', bottom: String(anchor.bottom) + 'px' },
            },
            popover,
            h(Notice, { notice: notice }),
          )
          try {
            popoverNode = createPortal(floating, document.body)
          } catch (error) {
            void error
            popoverNode = h(
              'div',
              { ref: popoverRef, className: 'bz-popover-wrap' },
              popover,
              h(Notice, { notice: notice }),
            )
          }
        } else {
          popoverNode = h(
            'div',
            { ref: popoverRef, className: 'bz-popover-wrap' },
            popover,
            h(Notice, { notice: notice }),
          )
        }
      }
      var floatingNotice = null
      if (
        popover === null &&
        notice !== null &&
        typeof document !== 'undefined' &&
        document !== null &&
        document.body !== null &&
        document.body !== undefined &&
        typeof createPortal === 'function'
      ) {
        try {
          floatingNotice = createPortal(
            h('div', { className: 'bz-toast-float' }, h(Notice, { notice: notice })),
            document.body,
          )
        } catch (error) {
          void error
          floatingNotice = null
        }
      }
      return h(
        'div',
        { ref: hostRef, className: 'bz-host' },
        h(
          'div',
          { className: 'bz-pills-row' },
          h('div', { className: 'bz-pills', role: 'group', 'aria-label': '能力集市入口' }, pills),
          // 「完整面板」的常驻入口：与三个胶囊排在同一行且画在崩溃边界之外，面板崩了这颗按钮还在。
          h(
            'button',
            {
              type: 'button',
              className: 'bz-pill',
              'data-active': open === true ? 'true' : 'false',
              'aria-label': '打开能力集市完整面板',
              title: '完整面板：多来源对比、技能与记忆、连接器',
              onClick: function () {
                setFullTab(kind === null ? 'expert' : kind)
                setKind(null)
                setOpen(true)
              },
            },
            gridIcon(13),
          ),
        ),
        popoverNode,
        floatingNotice,
        open === true
          ? h(
              DialogBoundary,
              null,
              h(PickerDialog, {
                open: true,
                initialTab: fullTab,
                sessionId: props.sessionId,
                onStateChange: function (payload) {
                  setPanel(payload)
                },
                onClose: function () {
                  setOpen(false)
                  setTick(function (previous) {
                    return previous + 1
                  })
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
                return '集市'
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
      MarketPopover,
      MarketRow,
      SessionPanel,
      SettingsScreen,
      VersionUpdateBlock,
      AccountBlock,
      CredentialBlock,
      CacheBlock,
      ConnectorBlock,
      RECENT_KINDS,
      RECENT_LIMIT,
      recentOf,
      categoryOf: function (kind) {
        return CATEGORIES[kind]
      },
      filterRows,
      rowsOf,
      fetchDomain,
      declares,
      declaredList,
    }
    return module.exports
  },
})
