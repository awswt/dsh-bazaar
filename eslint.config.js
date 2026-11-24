import js from '@eslint/js'

/**
 * 质量门的规则面。三条纪律：
 * - recommended 打底；
 * - no-unused-vars / eqeqeq 全量生效（lib scripts test 三目录）；
 * - no-console 只限 scripts/：命令行脚本的 stdout 是被测试断言的契约（见 test/release-script.test.mjs），
 *   所以这里不是"允许打印"，而是"把打印纳入抑制清单"——新增一条就要显式登记。
 * 存量违规一律进 eslint-suppressions.json，由 scripts/quality-gate.mjs 断言新增条目数为 0。
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'openspec/**',
      '.agents/**',
      'docs/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // 运行环境真实存在的全局：lib/client.js 跑在宿主浏览器上下文，其余跑在 Node。
      // 这里声明它们是「补全环境」，不是「放宽规则」——清单外仍需显式抑制。
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        DOMParser: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
        HTMLElement: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        requestAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'error',
      eqeqeq: 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'error' },
  },
]
