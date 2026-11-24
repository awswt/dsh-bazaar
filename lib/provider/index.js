/**
 * provider 契约的公开入口（package.json 的 ./provider）。
 *
 * 第三方 provider 只需要 import 这一个路径：拿常量写声明、拿 CODES 返回失败码、
 * 拿 createProviderRegistry 在测试里自证契约。运行期注册仍走 ctx.bazaar.providers.register，
 * 这里导出的不是第二条注册通道。
 *
 * 刻意不导出带 impl 的内部读取口；也不把目录拼装开放给外部指定，目录归属恒由
 * providerId 推导（组 4 的跨 provider 隔离依赖这一点）。
 */

export {
  API_VERSION,
  CAPABILITY_DOMAINS,
  PROVIDER_ID_PATTERN,
  REQUIRED_DECLARATION_FIELDS,
  REQUIRED_METHODS,
  declarationOf,
  declaresDomain,
  methodSurface,
  normalizeCapabilities,
  validateContract,
} from './contract.js'

export { BazaarError, CODES, fail, isFailure, ok, toEnvelope } from './errors.js'

export {
  PROVIDERS_DIR_NAME,
  assertProviderId,
  credentialNameFor,
  ownedProviderIdOf,
  providerDir,
  providerLayout,
  providersRoot,
  resolveCredentialName,
  safeJoin,
} from './paths.js'

export { createProviderRegistry } from './registry.js'

export { createDomainDispatcher } from './dispatch.js'

// 分组返回层：补 providerId / qualifiedName 的唯一位置，第三方不需要自己拼。
export { createDomainViews } from './domains.js'
