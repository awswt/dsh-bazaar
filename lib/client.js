/**
 * dsh-bazaar — client half.
 *
 * Adds a compact "专家" pill to `conversation.input.left` (the composer's
 * left-side control seat) and a session-scoped picker dialog with four tabs:
 *
 *   - 专家: live WorkBuddy market + locally installed experts;
 *   - 技能: expert skills + global skills, with search;
 *   - 连接器: installed connector plugins (per-session tool gating) and the
 *     MCP connector catalog;
 *   - 账号: this plugin's own WorkBuddy sign-in (scan the code, nothing else).
 *
 * Also registers one page in the settings shell (`settings.section` +
 * `settings.section.icon`, id `bazaar-account`) so the sign-in flow is
 * reachable without an open conversation: the pill is a per-session convenience,
 * the account is a machine-wide fact.
 *
 * All state comes from the host half's JSON routes under
 * `/dsh-bazaar/*`; the client never writes expert state itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bazaar',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var createPortal = null
    try {
      var reactDom = require('react-dom')
      if (reactDom !== null && reactDom !== undefined && typeof reactDom.createPortal === 'function') {
        createPortal = reactDom.createPortal
      }
    } catch (error) {
      createPortal = null
    }

    var PACKAGE_ID = 'dsh-bazaar'
    var SLOT_NAME = 'conversation.input.left'
    var ENTRY_ID = 'bazaar-expert-picker'
    var ENTRY_ORDER = 26
    // 设置页里的那一页：id 必须自成一格（用官方 id 会顶掉别人的页），
    // order 25 落在「插件(15)」之后、「记忆/其它」之前，一眼能找到。
    var SETTINGS_SLOT = 'settings.section'
    var SETTINGS_ICON_SLOT = 'settings.section.icon'
    var SETTINGS_ENTRY_ID = 'bazaar-account'
    var SETTINGS_ENTRY_ORDER = 25
    var STYLE_ID = PACKAGE_ID + '-styles'
    var ROUTES = {
      state: '/dsh-bazaar/state',
      experts: '/dsh-bazaar/experts',
      accounts: '/dsh-bazaar/accounts',
      accountsAction: '/dsh-bazaar/accounts/action',
      connectors: '/dsh-bazaar/connectors',
      connectorsSession: '/dsh-bazaar/connectors/session',
      connectorsAction: '/dsh-bazaar/connectors/action',
      connectorsState: '/dsh-bazaar/connectors/state',
      skillMarket: '/dsh-bazaar/skill-market',
      skillInstall: '/dsh-bazaar/skill-install',
      select: '/dsh-bazaar/select',
      skills: '/dsh-bazaar/skills',
      off: '/dsh-bazaar/off',
    }

    var inject = ['slots', 'remote']

    var CSS = [
      '.bz-host{display:contents}',
      '.bz-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;',
      'border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;',
      'cursor:pointer;white-space:nowrap;user-select:none;max-width:240px;',
      'transition:background-color .1s ease,color .1s ease,opacity .14s ease}',
      '.bz-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary)}',
      '.bz-pill:active{transform:translateY(.5px)}',
      '.bz-pill:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent);outline-offset:1px}',
      '.bz-pill[data-active="1"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));font-weight:600}',
      '.bz-pill__icon{width:14px;height:14px;flex:none;display:block}',
      '.bz-pill__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;',
      'font-weight:600}',
      '@media (max-width:860px){.bz-pill__name{display:none}.bz-pill{padding:0 6px}}',
      '.bz-scrim{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / 32%));',
      'backdrop-filter:var(--dsw-mask-blur,blur(6px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(6px));',
      'animation:bz-fade .16s ease}',
      '@keyframes bz-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes bz-rise{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}',
      '.bz-panel{display:flex;flex-direction:column;width:min(820px,100%);height:min(620px,calc(100vh - 48px));',
      'box-sizing:border-box;border-radius:16px;overflow:hidden;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-layer-2,#1c1d21);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));',
      'box-shadow:0 24px 64px rgb(0 0 0 / 32%);animation:bz-rise .2s cubic-bezier(.16,1,.3,1);',
      'font-size:13px;line-height:1.5}',
      '.bz-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px}',
      '.bz-head__text{flex:1;min-width:0}',
      '.bz-title{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em}',
      '.bz-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.bz-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'cursor:pointer;flex:none}',
      '.bz-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary)}',
      '.bz-tabs{display:flex;gap:4px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.bz-tab{position:relative;height:34px;padding:0 10px;border:none;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.bz-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.bz-tab[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.bz-tab[data-on="1"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;',
      'border-radius:2px;background:var(--dsw-alias-label-primary)}',
      '.bz-tab__count{margin-left:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.bz-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 18px}',
      '.bz-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.bz-search{flex:1;display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;',
      'border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));',
      'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03))}',
      '.bz-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.bz-search input::placeholder{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.38))}',
      '.bz-chips{display:flex;gap:6px;overflow-x:auto;padding:0 0 10px;scrollbar-width:thin}',
      '.bz-chip{flex:none;height:24px;padding:0 10px;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;',
      'color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.bz-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.bz-chip[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600;',
      'border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.bz-active{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:12px;border-radius:11px;',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.bz-active__text{flex:1;min-width:0}',
      '.bz-active__name{font-weight:600}',
      '.bz-active__meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-list{display:flex;flex-direction:column;gap:6px}',
      '.bz-expert{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;',
      'border:1px solid transparent;transition:background-color .1s ease,border-color .1s ease}',
      '.bz-expert:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      'border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.07))}',
      '.bz-expert[data-on="1"]{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}',
      '.bz-avatar{position:relative;width:34px;height:34px;border-radius:9px;flex:none;overflow:hidden;',
      'display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18))}',
      '.bz-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '.bz-expert__text{flex:1;min-width:0}',
      '.bz-expert__name{display:flex;align-items:center;gap:6px;font-weight:600;min-width:0}',
      '.bz-expert__name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-expert__desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-badge{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:5px;',
      'color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      '.bz-badge[data-kind="installed"]{color:var(--dsw-alias-state-success-primary,#2fbf71);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fbf71) 38%,transparent)}',
      '.bz-badge[data-kind="local"]{color:var(--dsw-alias-state-warn-primary,#e0a33a);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a33a) 38%,transparent)}',
      '.bz-badge[data-kind="connected"]{color:var(--dsw-alias-state-success-primary,#2fbf71);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fbf71) 38%,transparent)}',
      '.bz-badge[data-kind="tools"]{color:var(--dsw-alias-label-secondary)}',
      '.bz-use{flex:none;height:26px;padding:0 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;',
      'border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);',
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 38%,transparent)}',
      '.bz-use:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.bz-use:disabled{opacity:.55;cursor:not-allowed}',
      '.bz-more{display:flex;justify-content:center;padding:12px 0 2px}',
      '.bz-btn{height:30px;padding:0 13px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;',
      'color:var(--dsw-alias-label-primary)}',
      '.bz-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      /* Monochrome primary: filled with the label colour, text in the surface
         colour, so light and dark themes both read without relying on a brand
         token that flips between black and white. */
      '.bz-btn--primary{color:var(--dsw-alias-bg-layer-2,#fff);border-color:transparent;',
      'background:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',
      '.bz-btn--primary:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 86%,var(--dsw-alias-bg-layer-2,#fff))}',
      '.bz-btn--primary:disabled{opacity:.45}',
      '.bz-btn--quiet{color:var(--dsw-alias-label-secondary)}',
      '.bz-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.bz-section{margin-bottom:16px}',
      '.bz-section__head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}',
      '.bz-section__title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);',
      'letter-spacing:.02em}',
      /* 设置页里的卡片（settings.section）：宿主给的是内容列，宽度由列决定，
         所以这里只约束上限，不写死宽度。 */
      '.bz-settings{display:flex;flex-direction:column;gap:12px;max-width:780px;padding:2px 0 10px}',
      '.bz-settings__hero{display:flex;align-items:flex-start;gap:10px}',
      '.bz-settings__title{margin:0;font-size:14px;font-weight:650;letter-spacing:-.01em}',
      '.bz-settings__url{display:block;width:100%;box-sizing:border-box;margin:6px 0 0;padding:7px 9px;',
      'border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));',
      'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px;word-break:break-all;user-select:all}',
      '.bz-skill{display:flex;align-items:flex-start;gap:9px;padding:7px 9px;border-radius:9px;cursor:pointer}',
      '.bz-skill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.bz-skill input{margin:3px 0 0;accent-color:var(--dsw-alias-label-primary);flex:none}',
      '.bz-skill__name{font-weight:500}',
      '.bz-skill__desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px}',
      '.bz-conn{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;',
      'border:1px solid transparent}',
      '.bz-conn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      'border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.07))}',
      '.bz-conn__icon{width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;',
      'justify-content:center;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18))}',
      '.bz-conn__icon svg{width:16px;height:16px;display:block}',
      '.bz-conn__text{flex:1;min-width:0}',
      '.bz-conn__name{display:flex;align-items:center;gap:6px;font-weight:600;min-width:0}',
      '.bz-conn__name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-conn__desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.bz-toggle{position:relative;display:inline-flex;width:36px;height:20px;flex:none;cursor:pointer}',
      '.bz-toggle input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:inherit}',
      '.bz-toggle i{position:absolute;inset:0;border-radius:999px;pointer-events:none;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.25));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));transition:background-color .15s ease}',
      '.bz-toggle i::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;',
      'border-radius:999px;background:var(--dsw-alias-label-secondary);transition:left .15s ease,background-color .15s ease}',
      '.bz-toggle input:checked + i{background:var(--dsw-alias-label-primary);border-color:transparent}',
      '.bz-toggle input:checked + i::after{left:18px;background:var(--dsw-alias-bg-layer-2,#fff)}',
      '.bz-toggle input:focus-visible + i{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);outline-offset:1px}',
      '.bz-link{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:7px;cursor:pointer;',
      'font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;flex:none}',
      '.bz-link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.bz-empty{padding:28px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.bz-empty--tight{padding:10px 4px;text-align:left}',
      '.bz-error{margin:0 0 10px;padding:8px 10px;border-radius:9px;font-size:12px;',
      'color:var(--dsw-alias-state-error-primary,#e5484d);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 10%,transparent)}',
      '.bz-foot{display:flex;align-items:center;gap:10px;padding:11px 18px;',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.bz-foot__status{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.bz-foot__actions{display:flex;gap:8px;flex:none}',
      '.bz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}',
      '.bz-card{display:flex;flex-direction:column;gap:8px;min-height:150px;padding:12px;border-radius:11px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));',
      'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));position:relative}',
      '.bz-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 35%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.bz-card[data-blocked="1"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a33a) 40%,transparent)}',
      '.bz-card__top{display:flex;align-items:flex-start;gap:9px}',
      '.bz-card__name{font-weight:650;font-size:13px;line-height:1.35;overflow-wrap:anywhere}',
      '.bz-card__summary{flex:1;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);',
      'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.bz-card__tags{display:flex;gap:5px;flex-wrap:wrap}',
      '.bz-card__actions{display:flex;gap:7px;flex-wrap:wrap}',
      '.bz-card__actions .bz-btn,.bz-card__actions .bz-link{flex:1;justify-content:center;min-width:78px}',
      '.bz-corner{position:absolute;right:9px;top:8px;font-size:10px;color:var(--dsw-alias-state-warn-primary,#e0a33a)}',
      '.bz-dialog-input{width:100%;box-sizing:border-box;min-height:72px;margin:8px 0;padding:8px 10px;',
      'border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));',
      'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px;word-break:break-all;resize:vertical}',
      '@media (max-width:640px){.bz-scrim{padding:10px}.bz-panel{height:calc(100vh - 20px);border-radius:12px}',
      '.bz-expert__desc{display:none}}',
      '@media (prefers-reduced-motion:reduce){.bz-scrim,.bz-panel{animation:none}.bz-pill{transition:none}}',
    ].join('')

    function installStyles() {
      try {
        if (typeof document === 'undefined') return
        var element = document.getElementById(STYLE_ID)
        if (element === null) {
          element = document.createElement('style')
          element.id = STYLE_ID
          document.head.appendChild(element)
        }
        element.textContent = CSS
      } catch (error) {
        // Styling is cosmetic; never break the composer over it.
      }
    }

    function apiUrl(path) {
      var relative = String(path).replace(/^\/+/, '')
      try {
        if (typeof document === 'undefined') return '/' + relative
        var resolved = new URL(relative, document.baseURI)
        return resolved.pathname + resolved.search
      } catch (error) {
        return '/' + relative
      }
    }

    async function requestJson(path, options) {
      var response = await fetch(apiUrl(path), options)
      var body = await response.json().catch(function () { return {} })
      if (!response.ok || body.ok === false) {
        var message = body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      return body
    }

    function getJson(path) {
      return requestJson(path, { cache: 'no-store', headers: { accept: 'application/json' } })
    }

    // 1.0.0 已删除 dsh-armory 桥接：连接器目录/授权/安装全部走本插件的 provider
    // 域方法（lib/provider/domains.js + lib/providers/workbuddy/connector-store.js），
    // 不再通过 ctx.get('remote.mcpManager') 调外部插件。

    function postJson(path, payload) {
      return requestJson(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    function initial(value) {
      var text = typeof value === 'string' ? value.trim() : ''
      return text === '' ? '?' : text.slice(0, 1).toUpperCase()
    }

    /**
     * 把连接器连接结果翻译成一句人话。
     * WorkBuddy 的连接结果是联合类型：connected / connecting / cancelled / action-required / failed，
     * action-required 还要看 action.kind 决定是填表单还是在浏览器里完成授权。
     */
    function connectorResultText(result, fallback) {
      var entry = result !== null && typeof result === 'object' ? result : {}
      var action = entry.action !== null && typeof entry.action === 'object' ? entry.action : null
      if (entry.status === 'connected') return '已连接：' + Number(entry.state && entry.state.toolCount ? entry.state.toolCount : 0) + ' 个工具可用'
      if (entry.status === 'connecting') {
        var pendingReason = (entry.state && entry.state.reason) || entry.reason || null
        return pendingReason && pendingReason.code === 'restart-required'
          ? '已写入启动补丁，重启 DSH 后生效'
          : '正在连接…'
      }
      if (entry.status === 'disconnected') return '已断开'
      if (entry.status === 'cancelled') return '已取消连接'
      if (entry.status === 'action-required') {
        if (action !== null && action.kind === 'form') {
          var fields = Array.isArray(action.fields) ? action.fields.map(function (field) { return field.label || field.name }) : []
          return '需要凭据：请在该连接器的输入框填写 ' + (fields.length === 0 ? 'Token' : fields.join('、'))
        }
        if (action !== null && typeof action.url === 'string' && action.url !== '') return '需要授权：在浏览器打开 ' + action.url
        return '需要授权后才能继续'
      }
      return entry.error || entry.message || fallback || '连接失败'
    }

    function personIcon() {
      return h('svg', { className: 'bz-pill__icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 8, r: 3.5 }),
        h('path', { d: 'M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5' }))
    }

    function closeIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    }

    function searchIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true', style: { opacity: 0.65, flex: 'none' } },
        h('circle', { cx: 11, cy: 11, r: 6.5 }),
        h('path', { d: 'M16 16l4 4' }))
    }

    function plugIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M9 3v5M15 3v5' }),
        h('path', { d: 'M6 8h12v3a6 6 0 0 1-12 0V8z' }),
        h('path', { d: 'M12 17v4' }))
    }

    function catalogIcon(name) {
      return h('div', { className: 'bz-avatar' }, h('span', null, initial(name)))
    }

    function Avatar(props) {
      var bad = React.useState(false)
      var failed = bad[0]
      var setFailed = bad[1]
      return h('div', { className: 'bz-avatar' },
        h('span', null, initial(props.name)),
        props.src && !failed
          ? h('img', { src: props.src, alt: '', loading: 'lazy', onError: function () { setFailed(true) } })
          : null)
    }

    function Badge(props) {
      return h('span', { className: 'bz-badge', 'data-kind': props.kind }, props.children)
    }

    function Toggle(props) {
      return h('label', { className: 'bz-toggle', 'aria-label': props.label },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          disabled: props.disabled === true,
          onChange: function (event) { props.onToggle(event.target.checked) },
        }),
        h('i', null))
    }

    /** One market row. */
    function ExpertRow(props) {
      var item = props.item
      var active = props.activeId === item.id
      return h('div', { className: 'bz-expert', 'data-on': active ? '1' : '0' },
        h(Avatar, { name: item.displayName || item.plugin || item.id, src: item.avatar }),
        h('div', { className: 'bz-expert__text' },
          h('div', { className: 'bz-expert__name' },
            h('span', { title: item.displayName || item.plugin }, item.displayName || item.plugin || item.id),
            item.installed ? h(Badge, { kind: 'installed' }, '已安装') : null,
            item.source === 'local' ? h(Badge, { kind: 'local' }, '本地') : null,
            item.expertType === 'team' ? h(Badge, null, '专家团') : null),
          h('div', { className: 'bz-expert__desc', title: item.profession || item.description },
            item.profession || item.description || '')),
        h('button', {
          type: 'button',
          className: 'bz-use',
          disabled: props.busy === true || active,
          onClick: function () { props.onChoose(item.id) },
        }, active ? '使用中' : props.busy === true ? '处理中…' : '使用'))
    }

    function SkillRow(props) {
      var skill = props.skill
      return h('label', { className: 'bz-skill' },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: function (event) { props.onToggle(skill.name, event.target.checked) },
        }),
        h('div', null,
          h('div', { className: 'bz-skill__name' }, skill.name),
          skill.description ? h('div', { className: 'bz-skill__desc' }, skill.description) : null))
    }

    function ConnectorRow(props) {
      var item = props.item
      return h('div', { className: 'bz-conn' },
        h('div', { className: 'bz-conn__icon' }, plugIcon()),
        h('div', { className: 'bz-conn__text' },
          h('div', { className: 'bz-conn__name' },
            h('span', { title: item.name }, item.name),
            item.version ? h(Badge, null, 'v' + item.version) : null,
            h(Badge, { kind: 'tools' }, item.toolCount + ' 个工具')),
          h('div', { className: 'bz-conn__desc' },
            item.description || (item.sampleTool ? '示例工具：' + item.sampleTool.name : '未注册工具'))),
        h(Toggle, {
          checked: props.enabled,
          disabled: props.busy === true,
          label: '在本会话启用 ' + item.name,
          onToggle: function (checked) { props.onToggle(item.id, checked) },
        }))
    }

    function CatalogRow(props) {
      var item = props.item
      var state = props.state !== null && typeof props.state === 'object' ? props.state : null
      var connecting = state !== null && state.connecting === true
      var needsRestart = state !== null && state.reason !== null && typeof state.reason === 'object' && state.reason.code === 'restart-required'
      var needsAuth = state !== null && state.reason !== null && typeof state.reason === 'object' && state.reason.code === 'unbound' && state.authMode === 'oauth2-pkce'
      // 连接由 dsh-mcp-connector 的管理页建立时，本行只作展示：授权/断开都在那边。
      var viaConnectorUi = state !== null && typeof state === 'object' && state.external !== null && typeof state.external === 'object'
      var copiedPair = React.useState(false)
      var copied = copiedPair[0]
      var setCopied = copiedPair[1]
      var copyId = function () {
        try {
          if (navigator !== null && navigator !== undefined && navigator.clipboard !== undefined) {
            void navigator.clipboard.writeText(String(item.id ?? ''))
          }
        } catch (error) {
          // Clipboard may be unavailable in a non-secure context.
        }
        setCopied(true)
        setTimeout(function () { setCopied(false) }, 1600)
      }
      var connectable = props.onConnect !== undefined && item.connectable === true
      // 目录声明了必填凭据但本机还没有：在行内直接收，不把用户丢到别的页面。
      var needsCredential = state !== null
        && state.credentialReady === false
        && (state.authMode === 'api-key' || state.authMode === 'bearer')
        && item.connected !== true
      var credPair = React.useState('')
      var credValue = credPair[0]
      var setCredValue = credPair[1]
      var actionCell
      if (connectable && viaConnectorUi) {
        // 连接归管理页管：这里只给一个跳转，不提供会和对方打架的"连接/断开"。
        // 管理页不支持 ?connector=<id> 深链，所以按钮不做假深链，只在跳转前记一次
        // 埋点，并把"去那边搜什么"写进提示。
        var uiOpen = state !== null && state.uiOpen !== null && typeof state.uiOpen === 'object' ? state.uiOpen : null
        var openedBefore = uiOpen !== null && Number(uiOpen.count ?? 0) > 0
        actionCell = h('div', { className: 'bz-conn__actions' },
          h('button', {
            type: 'button',
            className: 'bz-btn',
            disabled: props.busy === true,
            title: '在连接器管理页完成授权、修复或断开（serverName: '
              + String(state.external.serverName || '') + (openedBefore ? '；已去过 ' + uiOpen.count + ' 次' : '') + '）',
            onClick: function () { props.onOpenUi(item.id, String(state.external.serverName || '')) },
          }, openedBefore ? '再次打开管理页' : '在管理页打开'),
          openedBefore
            ? h('span', {
              className: 'bz-sub',
              title: '上次跳转到连接器管理页的时间',
              style: { fontSize: '11px' },
            }, '已去过管理页')
            : null)
      } else if (connectable) {
        actionCell = h('div', { className: 'bz-conn__actions' },
          needsCredential
            ? h('input', {
              type: 'password',
              className: 'bz-input',
              style: { width: '150px' },
              placeholder: state.authMode === 'bearer' ? '粘贴 Bearer Token' : '粘贴 API Key',
              value: credValue,
              autoComplete: 'off',
              onChange: function (event) { setCredValue(event.target.value) },
            })
            : null,
          h('button', {
            type: 'button',
            className: 'bz-btn ' + (item.connected ? 'bz-btn--quiet' : 'bz-btn--primary'),
            disabled: props.busy === true || connecting || (needsCredential && credValue.trim() === ''),
            title: item.connected ? '断开并移除启动补丁条目' : '写入启动补丁并登记凭据',
            onClick: function () {
              if (item.connected) props.onDisconnect(item.id)
              else props.onConnect(item.id, needsCredential ? credValue.trim() : '')
            },
          }, connecting ? '连接中…' : item.connected ? '断开' : needsAuth ? '去授权' : needsCredential ? '保存并连接' : '连接'),
          h('button', { type: 'button', className: 'bz-link', title: '复制连接器 ID：' + (item.id ?? ''), onClick: copyId }, copied ? '已复制' : '复制 ID'))
      } else if (item.action === 'install') {
        // 市场技能的主动作是「安装」：下载 zip 并写进当前工作区的 .dsh/skills。
        // 不再提供「复制 ID」——技能现在能直接装进 DSH，复制 ID 只会误导用户
        // 以为还得去 CLI 手动装一遍。
        actionCell = h('div', { className: 'bz-conn__actions' },
          h('button', {
            type: 'button',
            className: 'bz-btn ' + (item.installed === true ? 'bz-btn--quiet' : 'bz-btn--primary'),
            disabled: props.busy === true,
            title: item.installed === true
              ? '重新下载并覆盖当前工作区里的同名技能'
              : '下载技能包并解压到当前工作区的 .dsh/skills',
            onClick: function () { if (props.onInstall !== undefined) props.onInstall(item) },
          }, props.busy === true ? '安装中…' : item.installed === true ? '重新安装' : '安装'))
      } else if (item.homepage) {
        actionCell = h('a', { className: 'bz-link', href: item.homepage, target: '_blank', rel: 'noopener noreferrer' }, '了解')
      } else {
        actionCell = h('span', { className: 'bz-badge' }, item.vendor || '')
      }
      return h('div', { className: 'bz-conn' },
        item.iconVisible ? h('div', { className: 'bz-avatar' }, item.icon ? h('img', { src: item.icon, alt: '', loading: 'lazy' }) : h('span', null, initial(item.name))) : catalogIcon(item.name),
        h('div', { className: 'bz-conn__text' },
          h('div', { className: 'bz-conn__name' },
            h('span', { title: item.name }, item.name),
            item.connected ? h(Badge, { kind: 'connected' }, '已连接') : null,
            connecting ? h(Badge, null, '连接中') : null,
            needsRestart ? h(Badge, null, '待重启生效') : null,
            needsAuth && !connecting ? h(Badge, null, '需授权') : null,
            item.viaConnectorUi === true || viaConnectorUi ? h(Badge, { title: '这条连接由连接器管理页建立：断开/授权在那边完成' }, '连接器管理页') : null,
            item.category ? h(Badge, null, item.category) : null,
            item.tools ? h(Badge, { kind: 'tools' }, item.tools + ' 工具') : null),
          h('div', { className: 'bz-conn__desc', title: item.summary }, item.summary || item.vendor || '')),
        actionCell)
    }

    function PickerDialog(props) {
      var sessionId = props.sessionId
      var pair = React.useState('expert')
      var tab = pair[0]
      var setTab = pair[1]

      var statePair = React.useState(null)
      var state = statePair[0]
      var setState = statePair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]

      var loadPair = React.useState(true)
      var loading = loadPair[0]
      var setLoading = loadPair[1]

      var queryPair = React.useState('')
      var query = queryPair[0]
      var setQuery = queryPair[1]
      var debouncedPair = React.useState('')
      var debounced = debouncedPair[0]
      var setDebounced = debouncedPair[1]
      var categoryPair = React.useState(null)
      var category = categoryPair[0]
      var setCategory = categoryPair[1]
      var pagePair = React.useState(1)
      var page = pagePair[0]
      var setPage = pagePair[1]

      var itemsPair = React.useState([])
      var items = itemsPair[0]
      var setItems = itemsPair[1]
      var morePair = React.useState(false)
      var hasMore = morePair[0]
      var setHasMore = morePair[1]
      var listErrorPair = React.useState(null)
      var listError = listErrorPair[0]
      var setListError = listErrorPair[1]
      var listLoadingPair = React.useState(false)
      var listLoading = listLoadingPair[0]
      var setListLoading = listLoadingPair[1]

      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var draftPair = React.useState({ globalMode: 'all', globalNames: [], expertNames: [] })
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var dirtyPair = React.useState(false)
      var dirty = dirtyPair[0]
      var setDirty = dirtyPair[1]

      var skillQueryPair = React.useState('')
      var skillQuery = skillQueryPair[0]
      var setSkillQuery = skillQueryPair[1]
      var skillDebouncedPair = React.useState('')
      var skillDebounced = skillDebouncedPair[0]
      var setSkillDebounced = skillDebouncedPair[1]
      var smItemsPair = React.useState([])
      var smItems = smItemsPair[0]
      var setSmItems = smItemsPair[1]
      var smMorePair = React.useState(false)
      var smHasMore = smMorePair[0]
      var setSmHasMore = smMorePair[1]
      var smPagePair = React.useState(1)
      var smPage = smPagePair[0]
      var setSmPage = smPagePair[1]
      var smLoadingPair = React.useState(false)
      var smLoading = smLoadingPair[0]
      var setSmLoading = smLoadingPair[1]
      var smErrorPair = React.useState(null)
      var smError = smErrorPair[0]
      var setSmError = smErrorPair[1]
      var smAuthPair = React.useState(false)
      var smAuthRequired = smAuthPair[0]
      var setSmAuthRequired = smAuthPair[1]
      var smTotalPair = React.useState(0)
      var smTotal = smTotalPair[0]
      var setSmTotal = smTotalPair[1]
      var smInstalledPair = React.useState([])
      var smInstalled = smInstalledPair[0]
      var setSmInstalled = smInstalledPair[1]
      var smWorkspacePair = React.useState('')
      var smWorkspace = smWorkspacePair[0]
      var setSmWorkspace = smWorkspacePair[1]
      var skillBusyPair = React.useState(null)
      var skillBusy = skillBusyPair[0]
      var setSkillBusy = skillBusyPair[1]
      var skillNoticePair = React.useState(null)
      var skillNotice = skillNoticePair[0]
      var setSkillNotice = skillNoticePair[1]
      var marketSourcePair = React.useState('workbuddy')
      var marketSource = marketSourcePair[0]
      var setMarketSource = marketSourcePair[1]

      var connPluginsPair = React.useState([])
      var connPlugins = connPluginsPair[0]
      var setConnPlugins = connPluginsPair[1]
      var connDisabledPair = React.useState(new Set())
      var connDisabled = connDisabledPair[0]
      var setConnDisabled = connDisabledPair[1]
      var connLoadingPair = React.useState(false)
      var connLoading = connLoadingPair[0]
      var setConnLoading = connLoadingPair[1]
      var connErrorPair = React.useState(null)
      var connError = connErrorPair[0]
      var setConnError = connErrorPair[1]
      var connBusyPair = React.useState(null)
      var connBusy = connBusyPair[0]
      var setConnBusy = connBusyPair[1]
      var connEpochPair = React.useState(0)
      var connEpoch = connEpochPair[0]
      var setConnEpoch = connEpochPair[1]
      var connStatesPair = React.useState({})
      var connStates = connStatesPair[0]
      var setConnStates = connStatesPair[1]
      // 中性提示（不是错误）：跳去连接器管理页后告诉用户去搜哪个名字。
      var connNoticePair = React.useState(null)
      var connNotice = connNoticePair[0]
      var setConnNotice = connNoticePair[1]

      // 账号（WorkBuddy 登录态）。本插件自己签、自己存，不再依赖 dsh-connect-workbuddy。
      var accLoadingPair = React.useState(false)
      var accLoading = accLoadingPair[0]
      var setAccLoading = accLoadingPair[1]
      var accErrorPair = React.useState(null)
      var accError = accErrorPair[0]
      var setAccError = accErrorPair[1]
      var accNoticePair = React.useState(null)
      var accNotice = accNoticePair[0]
      var setAccNotice = accNoticePair[1]
      var accOwnPair = React.useState([])
      var accOwn = accOwnPair[0]
      var setAccOwn = accOwnPair[1]
      var accLegacyPair = React.useState([])
      var accLegacy = accLegacyPair[0]
      var setAccLegacy = accLegacyPair[1]
      var accSummaryPair = React.useState(null)
      var accSummary = accSummaryPair[0]
      var setAccSummary = accSummaryPair[1]
      var accBusyPair = React.useState(null)
      var accBusy = accBusyPair[0]
      var setAccBusy = accBusyPair[1]
      // 一次登录会话：loginId + 给人打开的地址 + 预计过期时刻。轮询靠它驱动。
      var accLoginPair = React.useState(null)
      var accLogin = accLoginPair[0]
      var setAccLogin = accLoginPair[1]
      var accRegionPair = React.useState('cn')
      var accRegion = accRegionPair[0]
      var setAccRegion = accRegionPair[1]

      var catQueryPair = React.useState('')
      var catQuery = catQueryPair[0]
      var setCatQuery = catQueryPair[1]
      var catDebouncedPair = React.useState('')
      var catDebounced = catDebouncedPair[0]
      var setCatDebounced = catDebouncedPair[1]
      var catCategoryPair = React.useState(null)
      var catCategory = catCategoryPair[0]
      var setCatCategory = catCategoryPair[1]
      var catPagePair = React.useState(1)
      var catPage = catPagePair[0]
      var setCatPage = catPagePair[1]
      var catItemsPair = React.useState([])
      var catItems = catItemsPair[0]
      var setCatItems = catItemsPair[1]
      var catMorePair = React.useState(false)
      var catHasMore = catMorePair[0]
      var setCatHasMore = catMorePair[1]
      var catLoadingPair = React.useState(false)
      var catLoading = catLoadingPair[0]
      var setCatLoading = catLoadingPair[1]
      var catErrorPair = React.useState(null)
      var catError = catErrorPair[0]
      var setCatError = catErrorPair[1]
      var catCategoriesPair = React.useState([])
      var catCategories = catCategoriesPair[0]
      var setCatCategories = catCategoriesPair[1]
      var catSourcePair = React.useState(null)
      var catSource = catSourcePair[0]
      var setCatSource = catSourcePair[1]
      var applyState = React.useCallback(function (next) {
        setState(next)
        setDraft({
          globalMode: next.skills && next.skills.globalMode === 'selected' ? 'selected' : 'all',
          globalNames: next.skills && Array.isArray(next.skills.globalNames) ? next.skills.globalNames.slice() : [],
          expertNames: next.skills && Array.isArray(next.skills.expertNames) ? next.skills.expertNames.slice() : [],
        })
        setDirty(false)
        var connectors = next && next.connectors ? next.connectors : null
        setConnDisabled(new Set(Array.isArray(connectors && connectors.disabled) ? connectors.disabled : []))
        if (typeof props.onStateChange === 'function') props.onStateChange(next)
      }, [props.onStateChange])

      var loadState = React.useCallback(async function () {
        if (sessionId === undefined || sessionId === null) return
        setLoading(true)
        setError(null)
        try {
          var body = await getJson(ROUTES.state + '?sessionId=' + encodeURIComponent(sessionId))
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [sessionId, applyState])

      React.useEffect(function () {
        if (props.open) void loadState()
      }, [props.open, loadState])

      var loadConnectors = React.useCallback(async function () {
        if (sessionId === undefined || sessionId === null) return
        setConnLoading(true)
        setConnError(null)
        try {
          var body = await getJson(ROUTES.connectors + '?view=plugins&sessionId=' + encodeURIComponent(sessionId))
          setConnPlugins(body.items)
          setConnDisabled(new Set(Array.isArray(body.disabled) ? body.disabled : []))
          var stateBody = await getJson(ROUTES.connectorsState + '?sessionId=' + encodeURIComponent(sessionId))
          setConnStates(stateBody && typeof stateBody.states === 'object' && stateBody.states !== null ? stateBody.states : {})
        } catch (failure) {
          setConnError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setConnLoading(false)
        }
      }, [sessionId])

      React.useEffect(function () {
        if (props.open && tab === 'connectors') void loadConnectors()
      }, [props.open, tab, loadConnectors])

      React.useEffect(function () {
        var timer = setTimeout(function () { setDebounced(query.trim()) }, 220)
        return function () { clearTimeout(timer) }
      }, [query])

      React.useEffect(function () {
        if (!props.open) return undefined
        var cancelled = false
        setListLoading(true)
        setListError(null)
        var params = new URLSearchParams({ page: String(page), pageSize: '24' })
        if (debounced !== '') params.set('query', debounced)
        if (category !== null) params.set('categoryId', category)
        getJson(ROUTES.experts + '?' + params.toString())
          .then(function (body) {
            if (cancelled) return
            setItems(function (previous) { return page === 1 ? body.items : previous.concat(body.items) })
            setHasMore(body.hasMore === true)
          })
          .catch(function (failure) {
            if (!cancelled) setListError(failure instanceof Error ? failure.message : String(failure))
          })
          .finally(function () {
            if (!cancelled) setListLoading(false)
          })
        return function () { cancelled = true }
      }, [props.open, debounced, category, page])

      React.useEffect(function () {
        setPage(1)
      }, [debounced, category])

      React.useEffect(function () {
        var timer = setTimeout(function () { setCatDebounced(catQuery.trim()) }, 220)
        return function () { clearTimeout(timer) }
      }, [catQuery])

      React.useEffect(function () {
        var timer = setTimeout(function () { setSkillDebounced(skillQuery.trim()) }, 220)
        return function () { clearTimeout(timer) }
      }, [skillQuery])

      React.useEffect(function () {
        setSmPage(1)
      }, [skillDebounced])

      React.useEffect(function () {
        if (!props.open || tab !== 'skills') return undefined
        var cancelled = false
        setSmLoading(true)
        setSmError(null)
        var params = new URLSearchParams({ query: skillDebounced, page: String(smPage), pageSize: '12' })
        if (sessionId !== undefined && sessionId !== null) params.set('sessionId', String(sessionId))
        getJson(ROUTES.skillMarket + '?' + params.toString())
          .then(function (body) {
            if (cancelled) return
            setSmAuthRequired(body.authRequired === true)
            setSmTotal(Number(body.total ?? 0))
            setSmHasMore(body.hasMore === true)
            setSmInstalled(Array.isArray(body.installed) ? body.installed : [])
            setSmWorkspace(typeof body.workspace === 'string' ? body.workspace : '')
            setSmItems(function (previous) { return smPage === 1 ? body.items : previous.concat(body.items) })
          })
          .catch(function (failure) {
            if (!cancelled) setSmError(failure instanceof Error ? failure.message : String(failure))
          })
          .finally(function () {
            if (!cancelled) setSmLoading(false)
          })
        return function () { cancelled = true }
      }, [props.open, tab, skillDebounced, smPage])

      React.useEffect(function () {
        setCatPage(1)
      }, [catDebounced, catCategory])

      React.useEffect(function () {
        if (!props.open || tab !== 'connectors') return undefined
        var cancelled = false
        setCatLoading(true)
        setCatError(null)
        var params = new URLSearchParams({ view: 'catalog', page: String(catPage), pageSize: '24' })
        if (catDebounced !== '') params.set('query', catDebounced)
        if (catCategory !== null) params.set('category', catCategory)
        getJson(ROUTES.connectors + '?' + params.toString())
          .then(function (body) {
            if (cancelled) return
            setCatSource(body.source === 'workbuddy' ? 'workbuddy' : 'local')
            setCatItems(function (previous) { return catPage === 1 ? body.items : previous.concat(body.items) })
            setCatHasMore(body.hasMore === true)
            if (Array.isArray(body.categories) && catCategories.length === 0) setCatCategories(body.categories)
          })
          .catch(function (failure) {
            if (!cancelled) setCatError(failure instanceof Error ? failure.message : String(failure))
          })
          .finally(function () {
            if (!cancelled) setCatLoading(false)
          })
        return function () { cancelled = true }
      }, [props.open, tab, catDebounced, catCategory, catPage, connEpoch])

      React.useEffect(function () {
        if (!props.open) return undefined
        var onKey = function (event) {
          if (event.key === 'Escape') props.onClose()
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [props.open, props.onClose])

      var choose = async function (expertId) {
        if (busy !== null) return
        setBusy(expertId)
        setError(null)
        try {
          var body = await postJson(ROUTES.select, { sessionId: sessionId, expertId: expertId })
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var remove = async function () {
        if (busy !== null) return
        setBusy('__off__')
        setError(null)
        try {
          var body = await postJson(ROUTES.off, { sessionId: sessionId })
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var toggleGlobal = function (name, checked) {
        var allNames = (state && state.globalSkills ? state.globalSkills : []).map(function (skill) { return skill.name })
        var selected = draft.globalMode === 'all' ? allNames.slice() : draft.globalNames.slice()
        var set = new Set(selected)
        if (checked) set.add(name)
        else set.delete(name)
        setDraft({ globalMode: 'selected', globalNames: Array.from(set), expertNames: draft.expertNames })
        setDirty(true)
      }

      var toggleExpert = function (name, checked) {
        var set = new Set(draft.expertNames)
        if (checked) set.add(name)
        else set.delete(name)
        setDraft({ globalMode: draft.globalMode, globalNames: draft.globalNames, expertNames: Array.from(set) })
        setDirty(true)
      }

      var setAllGlobal = function (checked) {
        setDraft({
          globalMode: checked ? 'all' : 'selected',
          globalNames: [],
          expertNames: draft.expertNames,
        })
        setDirty(true)
      }

      var saveSkills = async function () {
        if (busy !== null) return
        setBusy('__skills__')
        setError(null)
        try {
          var body = await postJson(ROUTES.skills, {
            sessionId: sessionId,
            globalMode: draft.globalMode,
            globalNames: draft.globalNames,
            expertNames: draft.expertNames,
          })
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      /**
       * 真实安装：下载技能包并落到 <workspace>/.dsh/skills/<slug>/。
       * 安装完成后重新拉一次 state，让「本机技能」列表立刻出现新技能。
       */
      var installFromMarket = async function (item, force) {
        if (item === null || item === undefined || skillBusy !== null) return
        var skillId = String(item.id || '')
        if (skillId === '') return
        var forced = force === true
        setSkillBusy(skillId)
        setSkillNotice(null)
        try {
          var body = await postJson(ROUTES.skillInstall, { skillId: skillId, sessionId: sessionId, force: forced })
          if (body.ok === true && body.installed) {
            var installed = body.installed
            setSmInstalled(function (previous) {
              return previous.indexOf(installed.slug) >= 0 ? previous : previous.concat([installed.slug])
            })
            setSkillNotice({
              kind: 'ok',
              text: '已安装「' + (installed.displayName || installed.slug) + '」→ ' + installed.path + '（' + (body.files || []).length + ' 个文件）'
                + (body.forcedLock === true ? '，已强制解除残留锁' : ''),
            })
            await loadState()
          } else {
            setSkillNotice({
              kind: 'error',
              text: body.authRequired === true
                ? '需要 WorkBuddy 登录态才能下载技能包：请先在连接器中登录'
                : (body.error || '安装失败'),
              retryId: body.authRequired === true ? null : skillId,
            })
          }
        } catch (failure) {
          setSkillNotice({
            kind: 'error',
            text: failure instanceof Error ? failure.message : String(failure),
            retryId: skillId,
          })
        } finally {
          setSkillBusy(null)
        }
      }

      var toggleConnector = async function (id, enabled) {
        var next = new Set(connDisabled)
        if (enabled) next.delete(id)
        else next.add(id)
        setConnDisabled(next)
        setConnError(null)
        try {
          var body = await postJson(ROUTES.connectorsSession, { sessionId: sessionId, disabled: Array.from(next) })
          applyState(body.state)
        } catch (failure) {
          setConnError(failure instanceof Error ? failure.message : String(failure))
          setConnDisabled(function (previous) {
            var rollback = new Set(previous)
            if (enabled) rollback.add(id)
            else rollback.delete(id)
            return rollback
          })
        }
      }

      /**
       * 跳到连接器管理页（`dsh-mcp-connector` 的 /mcp-connector/ui）。
       *
       * 那份 UI 只读 `uiLocale` / `locale`，**不支持** `?connector=<id>` 深链，
       * 所以这里不假装能定位到某一行：先把"这一行去过管理页"记到插件自己的
       * store（`openConnectorUi` 埋点），拿到服务端算好的搜索提示，再真正跳转。
       * 计数器/时间戳让用户和排查者都能看出"已经去过了"，不必重复点。
       */
      var openConnectorUi = async function (id, serverName) {
        setConnError(null)
        setConnBusy(id)
        try {
          var body = await postJson(ROUTES.connectorsAction, {
            action: 'openConnectorUi',
            connectorId: id,
            sessionId: sessionId,
            serverName: serverName,
          })
          var target = body !== null && typeof body.url === 'string' && body.url !== ''
            ? body.url
            : '/mcp-connector/ui'
          if (body !== null && typeof body.hint === 'string' && body.hint !== '') {
            setConnNotice({ kind: 'ok', text: body.hint })
          }
          await loadConnectors()
          setConnEpoch(function (value) { return value + 1 })
          try {
            window.open(target, '_blank', 'noopener')
          } catch (failure) {
            // A popup blocker is normal; the hint above still tells the user where to go.
          }
        } catch (failure) {
          setConnError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setConnBusy(null)
        }
      }

      /**
       * 连接器连接/断开：走 WorkBuddy 语义的结果联合类型。
       * action-required 表示还缺凭据或需要 OAuth 授权，此时把提示带到 UI，而不是假装连上了。
       */
      var runConnectorAction = async function (id, action, extra) {
        setConnError(null)
        setConnBusy(id)
        try {
          var payload = {
            action: action,
            connectorId: id,
            sessionId: sessionId,
          }
          if (extra !== null && typeof extra === 'object') {
            if (typeof extra.token === 'string' && extra.token !== '') payload.token = extra.token
            if (extra.credentials !== null && typeof extra.credentials === 'object') payload.credentials = extra.credentials
            if (typeof extra.header === 'string' && extra.header !== '') payload.header = extra.header
          }
          var body = await postJson(ROUTES.connectorsAction, payload)
          var result = body.result || {}
          if (body.ok !== true) {
            setConnError(connectorResultText(result, body.error))
          } else if (result.status === 'action-required') {
            setConnError(connectorResultText(result))
          }
          await loadConnectors()
          setConnEpoch(function (value) { return value + 1 })
        } catch (failure) {
          setConnError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setConnBusy(null)
        }
      }

      /**
       * 账号列表：本插件自己的库（own）与旧插件 vault（legacy，只读）分开给。
       * 不在这里做"哪个能用"的判断——`usable` 由服务端算，客户端照抄。
       */
      var loadAccounts = React.useCallback(async function () {
        setAccLoading(true)
        setAccError(null)
        try {
          var body = await getJson(ROUTES.accounts)
          if (body !== null && body.available === false) {
            setAccOwn([])
            setAccLegacy([])
            setAccSummary(null)
            return
          }
          setAccOwn(Array.isArray(body.own) ? body.own : [])
          setAccLegacy(Array.isArray(body.all) ? body.all.filter(function (row) {
            return row !== null && typeof row === 'object' && row.source === 'vault'
          }) : [])
          setAccSummary(body.summary !== null && typeof body.summary === 'object' ? body.summary : null)
        } catch (failure) {
          setAccError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAccLoading(false)
        }
      }, [])

      React.useEffect(function () {
        if (props.open && tab === 'account') void loadAccounts()
      }, [props.open, tab, loadAccounts])

      /**
       * 关闭态早退。位置很关键：必须在**所有** hook 之后。
       *
       * 这里曾经把这一行放在账号区的 useCallback/useEffect 之前，于是 open=false 时渲染
       * 走到一半就 return 了，点开弹窗那一帧忽然多执行两个 hook，React 抛
       * "Rendered more hooks than during the previous render"。宿主
       * @deepseek-ai/dsh-client-ui-renderer 的 SlotErrorBoundary 捕获后，因为
       * conversation.input.left 是 kind:'list'（非 chain）就把整个 entry abdicate 掉——
       * pill 与弹窗是同一个 entry，于是"点一次按钮就永久消失，重启才回来"。
       *
       * 结论：任何条件 return 都不能站在 hook 前面。要早退就退到最后一行 hook 之后，
       * 或者把弹窗拆成独立组件（关掉时不挂载）。
       */
      if (!props.open) return null

      /**
       * 发起登录：服务端只创建 state，不阻塞等人扫码。
       * 返回的 verificationUri 必须由人打开——这里用 window.open，被拦就把地址显示出来。
       */
      var startAccountLogin = async function () {
        if (accBusy !== null) return
        setAccBusy('login')
        setAccError(null)
        setAccNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'start', region: accRegion })
          if (body !== null && body.ok !== true) {
            setAccError(body.error || '无法发起登录')
            return
          }
          setAccLogin({
            loginId: body.loginId,
            verificationUri: body.verificationUri,
            region: body.region,
            expiresAt: Date.now() + Number(body.expiresIn || 600) * 1000,
          })
          setAccNotice('在浏览器打开下面的链接完成登录，然后回到这里点「我已完成」。')
          try {
            window.open(body.verificationUri, '_blank', 'noopener')
          } catch (failure) {
            // 弹窗被拦是正常的：地址就显示在面板上。
          }
        } catch (failure) {
          setAccError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAccBusy(null)
        }
      }

      /**
       * 查一次登录结果。成功后服务端已经把账号写进本插件自己的账号库，
       * 所以这里只需要刷新列表——不要在前端再存一份 token。
       */
      var pollAccountLogin = async function () {
        if (accLogin === null || accBusy === 'poll') return
        setAccBusy('poll')
        try {
          var body = await postJson(ROUTES.accountsAction, {
            action: 'poll',
            loginId: accLogin.loginId,
            region: accLogin.region,
          })
          if (body !== null && body.ok === true && body.done === true) {
            if (body.error !== undefined) {
              setAccError(String(body.error))
            } else {
              var account = body.account !== null && typeof body.account === 'object' ? body.account : null
              setAccNotice(account === null
                ? '登录成功'
                : '已登录：' + (account.nickname || account.uid || account.accountId) + (account.region === 'global' ? '（国际版）' : '（国内版）'))
              setAccLogin(null)
            }
            await loadAccounts()
            await loadState()
          } else if (body !== null && body.pending === true) {
            setAccNotice('还没完成扫码，继续在浏览器里操作。')
          } else if (body !== null && body.done !== true) {
            setAccNotice('检查中…')
          } else if (body !== null && body.ok !== true) {
            setAccError(body.error || '查询登录结果失败')
          }
        } catch (failure) {
          setAccError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAccBusy(null)
        }
      }

      var cancelAccountLogin = async function () {
        if (accLogin === null) return
        var loginId = accLogin.loginId
        setAccLogin(null)
        setAccNotice(null)
        try {
          await postJson(ROUTES.accountsAction, { action: 'cancel', loginId: loginId })
        } catch (failure) {
          // 取消失败没有副作用：服务端 TTL 会自己清掉。
        }
      }

      var refreshAccount = async function (accountId) {
        setAccBusy('refresh:' + accountId)
        setAccError(null)
        setAccNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'refresh', accountId: accountId })
          if (body !== null && body.ok === true) {
            setAccNotice('已刷新 token')
            await loadAccounts()
            await loadState()
          } else {
            setAccError(body !== null && body.error ? body.error : '刷新失败')
          }
        } catch (failure) {
          setAccError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAccBusy(null)
        }
      }

      var removeAccount = async function (accountId) {
        setAccBusy('remove:' + accountId)
        setAccError(null)
        setAccNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'remove', accountId: accountId })
          if (body !== null && body.ok === true) {
            setAccNotice('已移除该账号')
            await loadAccounts()
            await loadState()
          } else {
            setAccError(body !== null && body.error ? body.error : '移除失败')
          }
        } catch (failure) {
          setAccError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAccBusy(null)
        }
      }

      /**
       * 把 dsh-connect-workbuddy 的 vault 一次性搬进来（那边只读，不改它）。
       * 之后即使卸掉那个插件，本插件仍然有可用 token。
       */
      var importLegacyAccounts = async function () {
        setAccBusy('import')
        setAccError(null)
        setAccNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'importLegacy' })
          if (body !== null && body.ok === true) {
            var imported = Number(body.imported ?? 0)
            setAccNotice(imported === 0 ? '没有可导入的账号' : '已导入 ' + imported + ' 个账号')
            await loadAccounts()
            await loadState()
          } else {
            setAccError(body !== null && body.error ? body.error : '导入失败')
          }
        } catch (failure) {
          setAccError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setAccBusy(null)
        }
      }

      var openMemorySkills = function () {
        props.onClose()
        try {
          // Preferred path: click the memory sidebar entry registered by
          // dsh-mnemon, then let its own tabs lead to 技能管理 → 市场.
          var entry = document.querySelector('[data-dsh-mnemon-entry]')
          if (entry !== null && typeof entry.click === 'function') {
            entry.click()
          } else {
            document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'mnemon' }))
            window.dispatchEvent(new CustomEvent('mnemon:anchor', { detail: { page: 'skills', tab: 'market' } }))
          }
        } catch (error) {
          // The memory plugin is optional; the user can open it from the sidebar.
        }
      }

      var active = state && state.expert ? state.expert : null
      var globalSkills = state && Array.isArray(state.globalSkills) ? state.globalSkills : []
      var expertSkills = state && Array.isArray(state.expertSkills) ? state.expertSkills : []
      var categories = state && Array.isArray(state.categories) ? state.categories : []
      // 「记忆系统技能市场」只是把用户送到 dsh-mnemon 自己的技能管理页，不是本插件的
      // 能力。没装那个包时点进去只有空白，所以整个页签不渲染。判定由服务端下发
      // （lib/mnemon.js），客户端不重复猜一遍 node_modules 的形状。
      var mnemon = state && state.mnemon !== null && typeof state.mnemon === 'object' ? state.mnemon : null
      var mnemonAvailable = mnemon !== null && mnemon.available === true
      // 当前选中 memory 但它已经不可用（例如刚在别的 profile 卸了插件）时，
      // 渲染必须回落到 workbuddy，否则页面是一片空白而页签已经不存在。
      var marketIsMemory = mnemonAvailable && marketSource === 'memory'
      var enabledGlobal = function (name) {
        return draft.globalMode === 'all' || draft.globalNames.indexOf(name) >= 0
      }
      var enabledExpert = function (name) {
        return draft.expertNames.indexOf(name) >= 0
      }

      var skillNeedle = skillQuery.trim().toLowerCase()
      var skillMatches = function (skill) {
        if (skillNeedle === '') return true
        return [skill.name, skill.description].filter(Boolean).join(' ').toLowerCase().indexOf(skillNeedle) >= 0
      }
      var expertSkillsShown = expertSkills.filter(skillMatches)
      var globalSkillsShown = globalSkills.filter(skillMatches)

      var head = h('div', { className: 'bz-head' },
        h('div', { className: 'bz-head__text' },
          h('h2', { className: 'bz-title' }, '会话辅助'),
          h('p', { className: 'bz-sub' },
            '仅作用于当前会话',
            state && state.market && state.market.marketTotal
              ? ' · 市场 ' + Number(state.market.marketTotal).toLocaleString() + ' 位专家'
              : '',
            state && state.market && state.market.source === 'cos' ? ' · 公开快照' : '',
            state && state.connectors && state.connectors.catalogSource === 'workbuddy'
              ? ' · 连接器市场 WorkBuddy'
              : state && state.connectors && state.connectors.catalogCount
                ? ' · 连接器目录 ' + Number(state.connectors.catalogCount).toLocaleString() + ' 个'
                : '')),
        h('button', { type: 'button', className: 'bz-iconbtn', onClick: props.onClose, 'aria-label': '关闭' }, closeIcon()))

      var connNeedle = catQuery.trim().toLowerCase()
      var connPluginsShown = connNeedle === ''
        ? connPlugins
        : connPlugins.filter(function (item) {
          return [item.id, item.name, item.packageName, item.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .indexOf(connNeedle) >= 0
        })
      var connectorCount = connPluginsShown.length
      var tabs = h('div', { className: 'bz-tabs', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', className: 'bz-tab', 'data-on': tab === 'expert' ? '1' : '0', onClick: function () { setTab('expert') } },
          '专家',
          active ? h('span', { className: 'bz-tab__count' }, '1') : null),
        h('button', { type: 'button', role: 'tab', className: 'bz-tab', 'data-on': tab === 'skills' ? '1' : '0', onClick: function () { setTab('skills') } },
          '技能',
          h('span', { className: 'bz-tab__count' }, String(draft.expertNames.length + (draft.globalMode === 'all' ? globalSkills.length : draft.globalNames.length)))),
        h('button', { type: 'button', role: 'tab', className: 'bz-tab', 'data-on': tab === 'connectors' ? '1' : '0', onClick: function () { setTab('connectors') } },
          '连接器',
          connectorCount > 0 ? h('span', { className: 'bz-tab__count' }, String(connectorCount)) : null),
        h('button', { type: 'button', role: 'tab', className: 'bz-tab', 'data-on': tab === 'account' ? '1' : '0', onClick: function () { setTab('account') } },
          '账号',
          accSummary !== null && Number(accSummary.usableCount) > 0
            ? h('span', { className: 'bz-tab__count' }, String(accSummary.usableCount))
            : null))

      var expertBody = h('div', null,
        active === null ? null : h('div', { className: 'bz-active' },
          h(Avatar, { name: active.displayName || active.id, src: null }),
          h('div', { className: 'bz-active__text' },
            h('div', { className: 'bz-active__name' }, active.displayName || active.id),
            h('div', { className: 'bz-active__meta' }, active.profession || active.plugin || '')),
          h('button', {
            type: 'button',
            className: 'bz-btn bz-btn--quiet',
            disabled: busy !== null,
            onClick: function () { void remove() },
          }, busy === '__off__' ? '移除中…' : '移除')),
        h('div', { className: 'bz-toolbar' },
          h('label', { className: 'bz-search' },
            searchIcon(),
            h('input', {
              value: query,
              placeholder: '搜索专家、职业或关键词',
              onChange: function (event) { setQuery(event.target.value) },
              'aria-label': '搜索专家',
            }))),
        categories.length === 0 ? null : h('div', { className: 'bz-chips', role: 'tablist' },
          h('button', { type: 'button', className: 'bz-chip', 'data-on': category === null ? '1' : '0', onClick: function () { setCategory(null) } }, '全部'),
          categories.map(function (entry) {
            return h('button', {
              key: entry.id,
              type: 'button',
              className: 'bz-chip',
              'data-on': category === entry.id ? '1' : '0',
              onClick: function () { setCategory(category === entry.id ? null : entry.id) },
            }, entry.name || entry.id)
          })),
        listError === null ? null : h('p', { className: 'bz-error' }, listError),
        items.length === 0 && listLoading
          ? h('div', { className: 'bz-empty' }, '正在加载专家…')
          : items.length === 0
            ? h('div', { className: 'bz-empty' }, '没有匹配的专家')
            : h('div', { className: 'bz-list' },
              items.map(function (item) {
                return h(ExpertRow, {
                  key: item.id,
                  item: item,
                  activeId: active ? active.id : null,
                  busy: busy === item.id,
                  onChoose: choose,
                })
              })),
        hasMore
          ? h('div', { className: 'bz-more' },
            h('button', { type: 'button', className: 'bz-btn', disabled: listLoading, onClick: function () { setPage(page + 1) } },
              listLoading ? '加载中…' : '加载更多'))
          : null)

      var skillsBody = h('div', null,
        h('div', { className: 'bz-toolbar' },
          h('label', { className: 'bz-search' },
            searchIcon(),
            h('input', {
              value: skillQuery,
              placeholder: '搜索技能：先本机，后技能市场',
              onChange: function (event) { setSkillQuery(event.target.value) },
              'aria-label': '搜索技能',
            }))),
        skillNeedle === '' && active !== null
          ? h('div', { className: 'bz-section' },
            h('div', { className: 'bz-section__head' },
              h('h3', { className: 'bz-section__title' }, '专家自带技能'),
              h('span', { className: 'bz-sub' }, active.displayName || active.id)),
            expertSkills.length === 0
              ? h('div', { className: 'bz-empty bz-empty--tight' }, '该专家没有声明技能。')
              : expertSkills.map(function (skill) {
                return h(SkillRow, {
                  key: skill.name,
                  skill: skill,
                  checked: enabledExpert(skill.name),
                  onToggle: toggleExpert,
                })
              }))
          : null,
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '本机技能'),
            h('button', {
              type: 'button',
              className: 'bz-btn bz-btn--quiet',
              onClick: function () { setAllGlobal(draft.globalMode !== 'all') },
            }, draft.globalMode === 'all' ? '全部停用' : '全部启用')),
          globalSkillsShown.length === 0
            ? h('div', { className: 'bz-empty bz-empty--tight' },
              skillNeedle !== '' ? '本机技能中没有匹配项。' : '当前没有可用的本机技能。')
            : globalSkillsShown.map(function (skill) {
              return h(SkillRow, {
                key: skill.name,
                skill: skill,
                checked: enabledGlobal(skill.name),
                onToggle: toggleGlobal,
              })
            })),
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '技能市场'),
            h('span', { className: 'bz-sub' }, marketIsMemory
              ? (mnemon && mnemon.version ? 'dsh-mnemon ' + mnemon.version + ' · 技能管理' : 'dsh-mnemon · 技能管理')
              : (smAuthRequired ? '需登录 WorkBuddy 连接器' : 'WorkBuddy · 共 ' + Number(smTotal).toLocaleString() + ' 条'))),
          h('div', { className: 'bz-chips' },
            h('button', {
              type: 'button',
              className: 'bz-chip',
              'data-on': marketIsMemory ? '0' : '1',
              onClick: function () { setMarketSource('workbuddy') },
            }, 'WorkBuddy 技能市场'),
            // 只有装了 dsh-mnemon 才给这个页签：没装时它指向一个不存在的页面。
            mnemonAvailable
              ? h('button', {
                type: 'button',
                className: 'bz-chip',
                'data-on': marketIsMemory ? '1' : '0',
                onClick: function () { setMarketSource('memory') },
              }, '记忆系统技能市场')
              : null),
          marketIsMemory
            ? h('div', { className: 'bz-active' },
              h('div', { className: 'bz-active__text' },
                h('div', { className: 'bz-active__name' }, '记忆系统 · 技能管理'),
                h('div', { className: 'bz-active__meta' }, '复用 dsh-mnemon 的技能管理页：技能 / 进化 / 评测 / 市场 / 回收站，市场技能可直接安装。')),
              h('button', { type: 'button', className: 'bz-btn bz-btn--primary', onClick: openMemorySkills }, '打开技能市场'))
            : h('div', null,
              // 不能用字符串拼接把 h('code') 拼进句子：那样 React 元素会被
              // toString 成 [object Object]（截图里出现过），必须作为数组 children 传入。
              h('p', { className: 'bz-sub', style: { margin: '0 0 8px' } },
                '安装会把技能包解到当前工作区的 ',
                h('code', null, '.dsh/skills/<技能名>/'),
                '，下一轮会话即可在「本机技能」中启用。',
                smWorkspace ? '当前工作区：' + smWorkspace : ''),
              smError === null ? null : h('p', { className: 'bz-error' }, smError),
              skillNotice === null
                ? null
                : h('div', { className: 'bz-sub', style: { margin: '0 0 8px' } },
                  h('p', { className: skillNotice.kind === 'ok' ? 'bz-sub' : 'bz-error', style: { margin: '0' } }, skillNotice.text),
                  // 只有失败且还知道是哪个技能时才给「强制重试」：残留锁通常是上一次
                  // 安装的进程被杀掉留下的，等 5 分钟过期太慢，但默认不该越过别人的活锁。
                  skillNotice.retryId
                    ? h('button', {
                      type: 'button',
                      className: 'bz-btn',
                      style: { marginTop: '4px' },
                      disabled: skillBusy !== null,
                      title: '直接清除 .lock-<技能名> 目录后重装；如果另一个进程真的在装，会打断它',
                      onClick: function () {
                        var target = smItems.filter(function (row) { return row.id === skillNotice.retryId })[0]
                        if (target === undefined) return
                        void installFromMarket(target, true)
                      },
                    }, '强制重试')
                    : null),
              smAuthRequired
                ? h('div', { className: 'bz-empty bz-empty--tight' }, '未检测到 WorkBuddy 登录态：请先在连接器中登录，再搜索技能市场。')
                : smLoading && smItems.length === 0
                  ? h('div', { className: 'bz-empty bz-empty--tight' }, '正在搜索技能市场…')
                  : smItems.length === 0
                    ? h('div', { className: 'bz-empty bz-empty--tight' }, '技能市场中没有匹配项。')
                    : h('div', { className: 'bz-list' },
                      smItems.map(function (item) {
                        var slug = typeof item.slug === 'string' ? item.slug : null
                        return h(CatalogRow, {
                          key: item.id,
                          busy: skillBusy === item.id,
                          onInstall: installFromMarket,
                          item: {
                            id: item.id,
                            name: item.name,
                            vendor: item.version ? 'v' + item.version : null,
                            category: '市场',
                            summary: item.description,
                            homepage: null,
                            connected: false,
                            tools: 0,
                            action: 'install',
                            installed: slug !== null && smInstalled.indexOf(slug) >= 0,
                          },
                        })
                      })),
              smHasMore
                ? h('div', { className: 'bz-more' },
                  h('button', { type: 'button', className: 'bz-btn', disabled: smLoading, onClick: function () { setSmPage(smPage + 1) } },
                    smLoading ? '加载中…' : '加载更多'))
                : null)))

      var connectorsBody = h('div', null,
        h('div', { className: 'bz-toolbar' },
          h('label', { className: 'bz-search' },
            searchIcon(),
            h('input', {
              value: catQuery,
              placeholder: '搜索连接器目录（名称、厂商、标签）',
              onChange: function (event) { setCatQuery(event.target.value) },
              'aria-label': '搜索连接器',
            }))),
        connError === null ? null : h('p', { className: 'bz-error' }, connError),
        connNotice === null ? null : h('p', { className: 'bz-sub' }, connNotice.text),
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '本机连接器'),
            h('span', { className: 'bz-sub' }, '开关只影响当前会话的工具')),
          connLoading && connPluginsShown.length === 0
            ? h('div', { className: 'bz-empty bz-empty--tight' }, '正在扫描本机连接器…')
            : connPluginsShown.length === 0
              ? h('div', { className: 'bz-empty bz-empty--tight' }, connNeedle !== '' ? '本机连接器中没有匹配项。' : '本机没有安装连接器插件。')
              : h('div', { className: 'bz-list' },
                connPluginsShown.map(function (item) {
                  return h(ConnectorRow, {
                    key: item.id,
                    item: item,
                    enabled: !connDisabled.has(item.id),
                    busy: false,
                    onToggle: function (id, enabled) { void toggleConnector(id, enabled) },
                  })
                }))),
        catError === null ? null : h('p', { className: 'bz-error' }, catError),
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '连接器市场'),
            h('span', { className: 'bz-sub' }, catSource === 'workbuddy'
              ? 'WorkBuddy 连接器市场 · 第 ' + catPage + ' 页'
              : catSource === 'local' ? '本地快照（未登录 WorkBuddy）' : '')),
          catCategories.length === 0 ? null : h('div', { className: 'bz-chips' },
            h('button', { type: 'button', className: 'bz-chip', 'data-on': catCategory === null ? '1' : '0', onClick: function () { setCatCategory(null) } }, '全部'),
            catCategories.map(function (entry) {
              return h('button', {
                key: entry,
                type: 'button',
                className: 'bz-chip',
                'data-on': catCategory === entry ? '1' : '0',
                onClick: function () { setCatCategory(catCategory === entry ? null : entry) },
              }, entry)
            })),
          h('div', null,
              catError === null ? null : h('p', { className: 'bz-error' }, catError),
              catItems.length === 0 && catLoading
                ? h('div', { className: 'bz-empty bz-empty--tight' }, '正在加载连接器目录…')
                : catItems.length === 0
                  ? h('div', { className: 'bz-empty bz-empty--tight' }, '目录中没有匹配的连接器。')
                  : h('div', { className: 'bz-list' },
                    catItems.map(function (item) {
                      var state = connStates !== null && typeof connStates === 'object' ? connStates[item.id] : undefined
                      return h(CatalogRow, {
                        key: item.id,
                        state: state,
                        busy: connBusy === item.id,
                        onConnect: function (id, value) {
                          void runConnectorAction(id, 'connect', typeof value === 'string' && value !== '' ? { token: value } : undefined)
                        },
                        onDisconnect: function (id) { void runConnectorAction(id, 'disconnect') },
                        onOpenUi: function (id, serverName) { void openConnectorUi(id, serverName) },
                        item: {
                          id: item.id,
                          name: item.name,
                          vendor: item.vendor,
                          category: item.category,
                          summary: item.summary,
                          homepage: catSource === 'local' ? item.homepage : null,
                          connected: state !== null && state !== undefined ? state.connected === true : item.connected,
                          tools: item.tools,
                          connectable: true,
                          action: 'copy',
                          iconVisible: catSource === 'workbuddy',
                          icon: item.icon,
                        },
                      })
                    }))),
          catHasMore
            ? h('div', { className: 'bz-more' },
              h('button', { type: 'button', className: 'bz-btn', disabled: catLoading, onClick: function () { setCatPage(catPage + 1) } },
                catLoading ? '加载中…' : '加载更多'))
            : null))

      /**
       * 账号页：本插件自己签发的 WorkBuddy 登录态。
       *
       * 三条设计取舍：
       *  - 登录是"开一个网址让人扫码"，不是内嵌表单，所以面板只负责把地址递出去；
       *  - token 只在服务端；这里只显示 nickname / uid / 到期时间；
       *  - 旧插件 vault 里的账号只能"导入"或"直接使用"，不能在这里刷新或删除
       *    （那边是别人的文件，我们不写）。
       */
      var accountRow = function (row) {
        var usable = row.usable === true
        var isOwn = row.source === 'helper'
        var label = row.nickname || row.uid || row.accountId
        var meta = [
          row.region === 'global' ? '国际版' : '国内版',
          row.domain ? String(row.domain) : '',
          row.expiresAt ? (row.expired === true ? 'access token 已过期' : '到期 ' + new Date(Number(row.expiresAt)).toLocaleString()) : '',
          isOwn ? '' : '来自 dsh-connect-workbuddy（只读）',
        ].filter(function (part) { return part !== '' }).join(' · ')
        return h('div', { key: String(row.accountId), className: 'bz-expert', 'data-on': usable ? '1' : '0' },
          h(Avatar, { name: label, src: typeof row.avatarUrl === 'string' ? row.avatarUrl : null }),
          h('div', { className: 'bz-expert__text' },
            h('div', { className: 'bz-expert__name' },
              h('span', null, label),
              usable ? h('span', { className: 'bz-badge', 'data-kind': 'connected' }, '可用') : null,
              row.hasRefreshToken === true ? h('span', { className: 'bz-badge' }, '可刷新') : null),
            h('div', { className: 'bz-expert__desc' }, meta)),
          isOwn
            ? h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
              h('button', {
                type: 'button',
                className: 'bz-use',
                disabled: accBusy !== null || row.hasRefreshToken !== true,
                title: row.hasRefreshToken === true ? '用 refresh token 换一张新的 access token' : '这个账号没有 refresh token，只能重新登录',
                onClick: function () { void refreshAccount(row.accountId) },
              }, accBusy === 'refresh:' + row.accountId ? '刷新中…' : '刷新'),
              h('button', {
                type: 'button',
                className: 'bz-btn bz-btn--quiet',
                disabled: accBusy !== null,
                onClick: function () { void removeAccount(row.accountId) },
              }, accBusy === 'remove:' + row.accountId ? '移除中…' : '移除'))
            : null)
      }

      var accountBody = h('div', null,
        h('p', { className: 'bz-sub', style: { margin: '0 0 10px' } },
          '本插件自己完成 WorkBuddy 登录并保存登录态，不需要安装 dsh-connect-workbuddy，也不需要 WorkBuddy 桌面端。',
          accSummary !== null && typeof accSummary.dir === 'string' ? '存放位置：' + accSummary.dir : ''),
        accError === null ? null : h('p', { className: 'bz-error' }, accError),
        accNotice === null ? null : h('p', { className: 'bz-sub' }, accNotice),
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '登录 WorkBuddy'),
            h('span', { className: 'bz-sub' }, '两个站点账号不通用，按你的账号选区')),
          h('div', { className: 'bz-chips' },
            [['cn', '国内版 codebuddy.cn'], ['global', '国际版 workbuddy.ai']].map(function (pair) {
              return h('button', {
                key: pair[0],
                type: 'button',
                className: 'bz-chip',
                'data-on': accRegion === pair[0] ? '1' : '0',
                onClick: function () { setAccRegion(pair[0]) },
              }, pair[1])
            })),
          accLogin === null
            ? h('div', { className: 'bz-toolbar' },
              h('button', {
                type: 'button',
                className: 'bz-btn bz-btn--primary',
                disabled: accBusy !== null,
                onClick: function () { void startAccountLogin() },
              }, accBusy === 'login' ? '正在创建登录…' : '开始登录'))
            : h('div', { className: 'bz-active' },
              h('div', { className: 'bz-active__text' },
                h('div', { className: 'bz-active__name' }, '等待浏览器里完成登录'),
                h('div', { className: 'bz-active__meta', title: accLogin.verificationUri }, accLogin.verificationUri)),
              h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
                h('button', {
                  type: 'button',
                  className: 'bz-btn bz-btn--primary',
                  disabled: accBusy === 'poll',
                  onClick: function () { void pollAccountLogin() },
                }, accBusy === 'poll' ? '检查中…' : '我已完成'),
                h('button', { type: 'button', className: 'bz-btn bz-btn--quiet', onClick: function () { void cancelAccountLogin() } }, '取消')))),
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '本插件保存的账号'),
            h('span', { className: 'bz-sub' }, accSummary !== null
              ? Number(accSummary.usableCount) + ' / ' + Number(accSummary.count) + ' 个可用'
              : '')),
          accLoading && accOwn.length === 0
            ? h('div', { className: 'bz-empty bz-empty--tight' }, '正在读取账号…')
            : accOwn.length === 0
              ? h('div', { className: 'bz-empty bz-empty--tight' }, '还没有登录过。上面选好站点后点「开始登录」。')
              : h('div', { className: 'bz-list' }, accOwn.map(accountRow))),
        h('div', { className: 'bz-section' },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, 'dsh-connect-workbuddy 的账号'),
            h('span', { className: 'bz-sub' }, accLegacy.length === 0 ? '没有找到旧插件的登录态' : '只读：导入后即可卸载那个插件')),
          accLegacy.length === 0
            ? null
            : h('div', null,
              h('div', { className: 'bz-list' }, accLegacy.map(accountRow)),
              h('div', { className: 'bz-toolbar', style: { marginTop: '8px' } },
                h('button', {
                  type: 'button',
                  className: 'bz-btn',
                  disabled: accBusy !== null,
                  title: '把旧插件 vault 里的账号复制进本插件的账号库，不改动旧文件',
                  onClick: function () { void importLegacyAccounts() },
                }, accBusy === 'import' ? '导入中…' : '全部导入本插件')))))

      var footStatus = error !== null
        ? error
        : tab === 'expert'
          ? (active ? '当前：' + (active.displayName || active.id) + (state && state.applied ? ' · 已生效' : ' · 下一条消息生效') : '未选择专家')
          : tab === 'skills'
            ? (dirty ? '技能有未保存修改' : '技能设置已生效')
            : tab === 'account'
              ? (accSummary !== null
                ? '可用账号 ' + Number(accSummary.usableCount) + ' 个'
                : '未连接账号')
              : ('本机连接器 ' + connectorCount + ' 个' + (connDisabled.size > 0 ? ' · 本会话停用 ' + connDisabled.size + ' 个' : ''))
      var foot = h('div', { className: 'bz-foot' },
        h('div', { className: 'bz-foot__status' },
          error !== null && tab !== 'expert'
            ? h('span', { className: 'bz-error', style: { margin: 0 } }, error)
            : footStatus),
        h('div', { className: 'bz-foot__actions' },
          tab === 'skills'
            ? h('button', {
              type: 'button',
              className: 'bz-btn bz-btn--primary',
              disabled: !dirty || busy !== null,
              onClick: function () { void saveSkills() },
            }, busy === '__skills__' ? '保存中…' : '保存技能')
            : h('button', { type: 'button', className: 'bz-btn bz-btn--quiet', onClick: props.onClose }, '关闭')))

      var body = loading && state === null
        ? h('div', { className: 'bz-body' }, h('div', { className: 'bz-empty' }, '正在读取会话状态…'))
        : h('div', { className: 'bz-body' }, error !== null && state === null ? h('p', { className: 'bz-error' }, error) : null,
          tab === 'expert' ? expertBody : tab === 'skills' ? skillsBody : tab === 'account' ? accountBody : connectorsBody)

      var panel = h('div', {
        className: 'bz-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '会话辅助',
        onMouseDown: function (event) { event.stopPropagation() },
      }, head, tabs, body, foot)

      var scrim = h('div', {
        className: 'bz-scrim',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose()
        },
      }, panel)

      if (createPortal === null) return scrim
      try {
        if (typeof document === 'undefined' || document === null || !document.body) return scrim
        return createPortal(scrim, document.body)
      } catch (error) {
        return scrim
      }
    }

    /**
     * 弹窗的出错误边界。
     *
     * 为什么需要它：pill 与弹窗是同一个 slot entry（conversation.input.left），而宿主
     * @deepseek-ai/dsh-client-ui-renderer 的 SlotErrorBoundary 对非 chain 槽位采取
     * "abdicate"——entry 里任何一处抛异常，整个 entry 被退役，pill 跟着消失，且只有
     * 重载页面/重启 DSH 才会重新注册。用户看到的现象就是"点一次按钮，按钮就没了"。
     *
     * 所以这里自带一层：弹窗崩了只吞掉弹窗（console.error 留证据），pill 永远活着。
     * 这不是掩盖 bug——真正的崩溃修在上面（hook 顺序），这层是防止下一次崩溃再演一遍
     * "按钮消失"这种最坏的用户体验。
     */
    class DialogBoundary extends (typeof React.Component === 'function' ? React.Component : Object) {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        try {
          console.error('[' + PACKAGE_ID + '] session dialog crashed; the composer pill stays mounted:', error)
        } catch (ignored) { /* console 不可用也不能再抛 */ }
      }

      render() {
        if (this.state.failed) return null
        return this.props.children === undefined ? null : this.props.children
      }
    }

    function ComposerEntry(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var summaryPair = React.useState(null)
      var summary = summaryPair[0]
      var setSummary = summaryPair[1]
      var sessionId = props.sessionId

      React.useEffect(function () {
        if (sessionId === undefined || sessionId === null) return undefined
        var cancelled = false
        getJson(ROUTES.state + '?sessionId=' + encodeURIComponent(sessionId))
          .then(function (body) { if (!cancelled) setSummary(body.state) })
          .catch(function () { if (!cancelled) setSummary(null) })
        return function () { cancelled = true }
      }, [sessionId, open])

      var expert = summary && summary.expert ? summary.expert : null
      var label = expert ? expert.displayName || expert.id : '专家'

      return h('div', { className: 'bz-host' },
        h('button', {
          type: 'button',
          className: 'bz-pill',
          'data-active': expert ? '1' : '0',
          title: expert ? '会话辅助 · 当前专家：' + label : '会话辅助：管理本会话的专家、技能与连接器',
          onClick: function () { setOpen(true) },
        }, personIcon(), h('span', null, '会话辅助'), expert ? h('span', { className: 'bz-pill__name' }, label) : null),
        /**
         * 弹窗只在打开时挂载，且包在自己的边界里：关着的时候不创建它的 React 树，
         * 崩了也只丢弹窗，pill 留在原地。
         */
        open
          ? h(DialogBoundary, null, h(PickerDialog, {
            open: true,
            sessionId: sessionId,
            onClose: function () { setOpen(false) },
            onStateChange: setSummary,
          }))
          : null)
    }

    /**
     * 设置页里的「WorkBuddy 登录」卡片。
     *
     * 存在的理由：会话里的 pill 只是随手入口，登录态是全局的东西，用户会去设置页找。
     * 这里刻意不复用 PickerDialog 的账号区——那是会话级的弹窗，一开就要拉会话状态；
     * 设置页只关心账号，自己带一份 state 更省事，也不会因为宿主不给 sessionId 而崩。
     *
     * 三条硬约束：
     *  - 注册无条件、渲染门控：apply() 里注册不看任何运行时条件，卡片自己读
     *    `available`；没注入账号服务就只说一句"不可用"，绝不抛错影响设置页；
     *  - token 只在服务端：这里只显示 nickname / uid / 到期时间；
     *  - 旧插件的 vault 只读：导入是复制，刷新/移除只对自有账号开放。
     */
    function SettingsAccountCard(props) {
      var statePair = React.useState(null)
      var view = statePair[0]
      var setView = statePair[1]
      var loadingPair = React.useState(true)
      var loading = loadingPair[0]
      var setLoading = loadingPair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]
      var noticePair = React.useState(null)
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var loginPair = React.useState(null)
      var login = loginPair[0]
      var setLogin = loginPair[1]
      var regionPair = React.useState('cn')
      var region = regionPair[0]
      var setRegion = regionPair[1]

      var load = React.useCallback(async function () {
        setLoading(true)
        setError(null)
        try {
          var body = await getJson(ROUTES.accounts)
          setView(body !== null && typeof body === 'object' ? body : null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(function () {
        void load()
      }, [load])

      var own = view !== null && Array.isArray(view.own) ? view.own : []
      var legacy = view !== null && Array.isArray(view.all)
        ? view.all.filter(function (row) {
          return row !== null && typeof row === 'object' && row.source === 'vault'
        })
        : []
      var summary = view !== null && view.summary !== null && typeof view.summary === 'object' ? view.summary : null
      var available = view !== null && view.available === true

      var start = async function () {
        if (busy !== null) return
        setBusy('login')
        setError(null)
        setNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'start', region: region })
          if (body !== null && body.ok !== true) {
            setError(body !== null && body.error ? body.error : '无法发起登录')
            return
          }
          setLogin({
            loginId: body.loginId,
            verificationUri: body.verificationUri,
            region: body.region,
          })
          setNotice('在浏览器里完成登录，然后回到这里点「我已完成」。')
          try {
            window.open(body.verificationUri, '_blank', 'noopener')
          } catch (failure) {
            // 弹窗被拦是常态：地址就在卡片上。
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var poll = async function () {
        if (login === null || busy === 'poll') return
        setBusy('poll')
        try {
          var body = await postJson(ROUTES.accountsAction, {
            action: 'poll',
            loginId: login.loginId,
            region: login.region,
          })
          if (body !== null && body.done === true && body.error !== undefined) {
            setError(String(body.error))
            setLogin(null)
          } else if (body !== null && body.done === true) {
            var account = body.account !== null && typeof body.account === 'object' ? body.account : null
            setNotice(account === null
              ? '登录成功'
              : '已登录：' + (account.nickname || account.uid || account.accountId)
                + (account.region === 'global' ? '（国际版）' : '（国内版）'))
            setLogin(null)
          } else if (body !== null && body.pending === true) {
            setNotice('还没完成扫码，继续在浏览器里操作。')
          } else if (body !== null && body.ok !== true) {
            setError(body.error || '查询登录结果失败')
          }
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var cancel = async function () {
        if (login === null) return
        var loginId = login.loginId
        setLogin(null)
        setNotice(null)
        try {
          await postJson(ROUTES.accountsAction, { action: 'cancel', loginId: loginId })
        } catch (failure) {
          // 取消失败没有副作用：服务端 TTL 会自己清掉。
        }
      }

      var refresh = async function (accountId) {
        setBusy('refresh:' + accountId)
        setError(null)
        setNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'refresh', accountId: accountId })
          if (body !== null && body.ok === true) setNotice('已刷新 token')
          else setError(body !== null && body.error ? body.error : '刷新失败')
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var remove = async function (accountId) {
        setBusy('remove:' + accountId)
        setError(null)
        setNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'remove', accountId: accountId })
          if (body !== null && body.ok === true) setNotice('已移除该账号')
          else setError(body !== null && body.error ? body.error : '移除失败')
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var importLegacy = async function () {
        setBusy('import')
        setError(null)
        setNotice(null)
        try {
          var body = await postJson(ROUTES.accountsAction, { action: 'importLegacy' })
          if (body !== null && body.ok === true) {
            var imported = Number(body.imported ?? 0)
            setNotice(imported === 0 ? '没有可导入的账号' : '已导入 ' + imported + ' 个账号')
          } else {
            setError(body !== null && body.error ? body.error : '导入失败')
          }
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var row = function (item) {
        var usable = item.usable === true
        var isOwn = item.source === 'helper'
        var label = item.nickname || item.uid || item.accountId
        var meta = [
          item.region === 'global' ? '国际版' : '国内版',
          item.domain ? String(item.domain) : '',
          item.expiresAt
            ? (item.expired === true ? 'access token 已过期' : '到期 ' + new Date(Number(item.expiresAt)).toLocaleString())
            : '',
          isOwn ? '' : '来自 dsh-connect-workbuddy（只读）',
        ].filter(function (part) { return part !== '' }).join(' · ')
        return h('div', { key: 'acc-' + String(item.accountId), className: 'bz-expert', 'data-on': usable ? '1' : '0' },
          h(Avatar, { name: label, src: typeof item.avatarUrl === 'string' ? item.avatarUrl : null }),
          h('div', { className: 'bz-expert__text' },
            h('div', { className: 'bz-expert__name' },
              h('span', null, label),
              usable ? h('span', { className: 'bz-badge', 'data-kind': 'connected' }, '可用') : null,
              item.hasRefreshToken === true ? h('span', { className: 'bz-badge' }, '可刷新') : null),
            h('div', { className: 'bz-expert__desc' }, meta)),
          isOwn
            ? h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
              h('button', {
                type: 'button',
                className: 'bz-use',
                disabled: busy !== null || item.hasRefreshToken !== true,
                title: item.hasRefreshToken === true ? '用 refresh token 换一张新的 access token' : '这个账号没有 refresh token，只能重新登录',
                onClick: function () { void refresh(item.accountId) },
              }, busy === 'refresh:' + item.accountId ? '刷新中…' : '刷新'),
              h('button', {
                type: 'button',
                className: 'bz-btn bz-btn--quiet',
                disabled: busy !== null,
                onClick: function () { void remove(item.accountId) },
              }, busy === 'remove:' + item.accountId ? '移除中…' : '移除'))
            : null)
      }

      if (view !== null && available === false) {
        return h('div', { className: 'bz-settings' },
          h('p', { className: 'bz-sub', style: { margin: '0' } },
            '本插件的服务端没有挂上账号服务（旧版本或被裁剪的构建），这里暂时无法登录。'))
      }

      return h('div', { className: 'bz-settings' },
        h('div', { className: 'bz-settings__hero' },
          personIcon(),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('h4', { className: 'bz-settings__title' }, 'WorkBuddy 账号'),
            h('p', { className: 'bz-sub', style: { margin: '2px 0 0' } },
              '登录由本插件自己完成，登录态只存在本机；不需要安装 dsh-connect-workbuddy，也不需要 WorkBuddy 桌面端。',
              summary !== null && typeof summary.dir === 'string' ? '存放位置：' + summary.dir : ''))),
        error === null ? null : h('p', { className: 'bz-error', style: { margin: '0' } }, error),
        notice === null ? null : h('p', { className: 'bz-sub', style: { margin: '0' } }, notice),

        h('div', { className: 'bz-section', style: { margin: '0' } },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '登录'),
            h('span', { className: 'bz-sub' }, '两个站点账号不通用，按你的账号选区')),
          h('div', { className: 'bz-chips' },
            [['cn', '国内版 codebuddy.cn'], ['global', '国际版 workbuddy.ai']].map(function (pair) {
              return h('button', {
                key: 'region-' + pair[0],
                type: 'button',
                className: 'bz-chip',
                'data-on': region === pair[0] ? '1' : '0',
                onClick: function () { setRegion(pair[0]) },
              }, pair[1])
            })),
          login === null
            ? h('div', { className: 'bz-toolbar', style: { margin: '0' } },
              h('button', {
                type: 'button',
                className: 'bz-btn bz-btn--primary',
                disabled: busy !== null,
                onClick: function () { void start() },
              }, busy === 'login' ? '正在创建登录…' : '开始登录'))
            : h('div', null,
              h('div', { className: 'bz-active', style: { margin: '0 0 8px' } },
                h('div', { className: 'bz-active__text' },
                  h('div', { className: 'bz-active__name' }, '等待浏览器里完成登录'),
                  h('div', { className: 'bz-active__meta' }, '上面的链接已尝试自动打开；没打开就复制：')),
                h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
                  h('button', {
                    type: 'button',
                    className: 'bz-btn bz-btn--primary',
                    disabled: busy === 'poll',
                    onClick: function () { void poll() },
                  }, busy === 'poll' ? '检查中…' : '我已完成'),
                  h('button', { type: 'button', className: 'bz-btn bz-btn--quiet', onClick: function () { void cancel() } }, '取消'))),
              h('code', { className: 'bz-settings__url' }, String(login.verificationUri ?? '')))),

        h('div', { className: 'bz-section', style: { margin: '0' } },
          h('div', { className: 'bz-section__head' },
            h('h3', { className: 'bz-section__title' }, '本插件保存的账号'),
            h('span', { className: 'bz-sub' }, summary !== null
              ? Number(summary.usableCount) + ' / ' + Number(summary.count) + ' 个可用'
              : '')),
          loading && own.length === 0
            ? h('div', { className: 'bz-empty bz-empty--tight' }, '正在读取账号…')
            : own.length === 0
              ? h('div', { className: 'bz-empty bz-empty--tight' }, '还没有登录过。上面选好站点后点「开始登录」。')
              : h('div', { className: 'bz-list' }, own.map(row))),

        legacy.length === 0
          ? null
          : h('div', { className: 'bz-section', style: { margin: '0' } },
            h('div', { className: 'bz-section__head' },
              h('h3', { className: 'bz-section__title' }, 'dsh-connect-workbuddy 的账号'),
              h('span', { className: 'bz-sub' }, '只读：导入后即可卸载那个插件')),
            h('div', { className: 'bz-list' }, legacy.map(row)),
            h('div', { className: 'bz-toolbar', style: { margin: '8px 0 0' } },
              h('button', {
                type: 'button',
                className: 'bz-btn',
                disabled: busy !== null,
                title: '把旧插件 vault 里的账号复制进本插件的账号库，不改动旧文件',
                onClick: function () { void importLegacy() },
              }, busy === 'import' ? '导入中…' : '全部导入本插件'))))
    }

    function apply(ctx) {
      installStyles()
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register({
            name: SLOT_NAME,
            id: ENTRY_ID,
            order: ENTRY_ORDER,
            label: function () { return '会话辅助' },
          }, function SlotComponent(props) {
            return h(ComposerEntry, props)
          })
        })
      } catch (error) {
        try {
          console.error('[' + PACKAGE_ID + '] composer pill registration failed:', error)
        } catch (ignored) {
          // Never break the composer over a missing slot.
        }
      }

      /*
       * 设置页里的一页「WorkBuddy 登录」。
       *
       * 注册是无条件的（宿主决定这一页什么时候被渲染），但每步都单独 try/catch：
       * 一个老宿主没有 settings.section 时，这里的失败不能连带把上面的 composer
       * 注入一起废掉——两个槽位互不依赖。
       *
       * 图标注册的 id 必须与 section 的 id 相同，宿主按 id 配对；
       * 对不上的图标永远不渲染。
       */
      try {
        ctx.slots.inject(SETTINGS_SLOT, function () {
          return ctx.slots.register({
            name: SETTINGS_SLOT,
            id: SETTINGS_ENTRY_ID,
            order: SETTINGS_ENTRY_ORDER,
            label: function () { return 'bazaar' },
          }, SettingsAccountCard)
        })
      } catch (error) {
        try {
          console.error('[' + PACKAGE_ID + '] settings section registration failed:', error)
        } catch (ignored) {
          // The settings page is optional on older hosts.
        }
      }

      try {
        ctx.slots.inject(SETTINGS_ICON_SLOT, function () {
          return ctx.slots.register({
            name: SETTINGS_ICON_SLOT,
            id: SETTINGS_ENTRY_ID,
          }, function SettingsAccountIcon(iconProps) {
            var size = iconProps !== null && iconProps !== undefined && Number.isFinite(Number(iconProps.size))
              ? Number(iconProps.size)
              : 16
            var active = iconProps !== null && iconProps !== undefined && iconProps.active === true
            return h('svg', {
              width: size,
              height: size,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
              style: { display: 'block', opacity: active ? 1 : 0.75 },
            },
            h('circle', { cx: 12, cy: 8, r: 3.5 }),
            h('path', { d: 'M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5' }))
          })
        })
      } catch (error) {
        try {
          console.error('[' + PACKAGE_ID + '] settings icon registration failed:', error)
        } catch (ignored) {
          // The nav icon is cosmetic; the section still shows its label.
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = { ROUTES, CSS, PickerDialog, ComposerEntry, SettingsAccountCard }
    return module.exports
  },
})
