import fs from 'node:fs'
import * as yaml from 'js-yaml'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { atomicWriteWithBackup, readConfig } from './config-file.js'

/**
 * Agent 模型配置写入器（参考 opencodex 的集成格式）。
 * 统一将 OpenHarness 本地代理（http://127.0.0.1:18200/v1）作为自定义 Provider
 * 合并进各 Harness 的模型配置文件：
 *   - JSON 文档（opencode/pi/prime/zcode/openclaw）：provider(V1) + providers(V2) 双块
 *   - YAML 文档（omp/gajae/hermes/minimax/dsh）：providers[V2] 块，可指定嵌套根路径
 *   - TOML 文档（kimi/grok）：codex 风格 model_provider 表
 */

const PROXY_BASE = 'http://127.0.0.1:18200/v1'
const V2_PACKAGE = '@opencode-ai/ai/providers/openai-compatible'

function readDoc(p) {
  return readConfig(p, JSON.parse, 'JSON')
}

function requireToken(token) {
  if (typeof token !== 'string' || !token) throw new Error('OpenHarness 配置 token 不能为空')
  if (/[\u0000-\u001f\u007f]/.test(token)) throw new Error('OpenHarness 配置 token 不能包含控制字符')
  return token
}

function objectField(doc, key) {
  const value = doc[key]
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`拒绝覆盖非对象配置字段: ${key}`)
  }
  return value
}

/**
 * 把结构化鉴权配置合成到 URL/请求头，兼容所有 MCP 服务的接入格式：
 *   query  → URL 参数（参数名可配：key/token/api_key…，默认 key）
 *   bearer → Authorization: Bearer <key>
 *   header → 自定义请求头（头名可配，默认 X-API-Key）
 * 无 auth 结构的旧记录原样透传（URL 里已拼好 key 的兼容）
 */
export function applyAuth(server) {
  let url = server.url || ''
  const headers = { ...(server.headers || {}) }
  const auth = server.auth
  const key = (auth?.key || '').trim()
  if (key && auth.mode === 'query') {
    const name = encodeURIComponent(auth.name || 'key')
    url += (url.includes('?') ? '&' : '?') + `${name}=${encodeURIComponent(key)}`
  } else if (key && auth.mode === 'bearer') {
    headers.Authorization = `Bearer ${key}`
  } else if (key && auth.mode === 'header') {
    headers[auth.name || 'X-API-Key'] = key
  }
  return { url, headers }
}

function modelMap(models) {
  const list = models?.length ? models : ['default']
  return Object.fromEntries(list.map((m) => [m, { name: m }]))
}

/** JSON 文档：合并 opencode 形状的 V1+V2 provider 块 */
export function mergeJsonAgentProviders(configPath, { models, model, token }) {
  const doc = readDoc(configPath)
  const mm = modelMap(models)
  const options = { baseURL: PROXY_BASE, apiKey: requireToken(token) }
  doc.provider = {
    ...objectField(doc, 'provider'),
    openharness: { npm: '@ai-sdk/openai-compatible', name: 'OpenHarness', options, models: mm }
  }
  doc.providers = {
    ...objectField(doc, 'providers'),
    openharness: { package: V2_PACKAGE, name: 'OpenHarness', settings: options, models: mm }
  }
  atomicWriteWithBackup(configPath, JSON.stringify(doc, null, 2))
  return { ok: true, path: configPath }
}

export function mergeClaudeCodeSettings(configPath, { models, model, token }) {
  const doc = readDoc(configPath)
  doc.env = {
    ...objectField(doc, 'env'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18200',
    ANTHROPIC_AUTH_TOKEN: requireToken(token)
  }
  if (model) doc.model = model
  atomicWriteWithBackup(configPath, JSON.stringify(doc, null, 2))
  return { ok: true, path: configPath, model }
}

/** YAML 文档：在 rootPath（如 ['providers'] 或 ['llm-pi-ai','providers']）下合并 V2 块 */
export function mergeYamlAgentProviders(configPath, { models, model, token }, rootPath = ['providers']) {
  const doc = readConfig(configPath, (source) => yaml.load(source) || {}, 'YAML')
  let node = doc
  for (const key of rootPath.slice(0, -1)) {
    if (node[key] === undefined) node[key] = {}
    else if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      throw new Error(`拒绝覆盖非对象配置字段: ${key}`)
    }
    node = node[key]
  }
  const last = rootPath[rootPath.length - 1]
  const current = objectField(node, last)
  node[last] = {
    ...current,
    openharness: {
      package: V2_PACKAGE,
      name: 'OpenHarness',
      settings: { baseURL: PROXY_BASE, apiKey: requireToken(token) },
      models: modelMap(models)
    }
  }
  atomicWriteWithBackup(configPath, yaml.dump(doc, { lineWidth: -1, noRefs: true }))
  return { ok: true, path: configPath }
}

/** opencode 形状的 mcp 块：remote（SSE/HTTP）+ local（stdio），合并注入 opencode.json */
export function mergeOpencodeMcp(configPath, servers) {
  const doc = readDoc(configPath)
  const existing = objectField(doc, 'mcp')
  const injected = []
  for (const s of servers || []) {
    if (s.transport === 'http' && s.url) {
      const { url, headers } = applyAuth(s)
      existing[s.name] = {
        type: 'remote',
        url,
        enabled: true,
        ...(Object.keys(headers).length ? { headers } : {})
      }
      injected.push(s.name)
    } else if (s.command) {
      existing[s.name] = {
        type: 'local',
        command: [s.command, ...(s.args || []).filter(Boolean)],
        enabled: true,
        ...(s.env ? { env: s.env } : {})
      }
      injected.push(s.name)
    }
  }
  doc.mcp = existing
  atomicWriteWithBackup(configPath, JSON.stringify(doc, null, 2))
  return { ok: true, path: configPath, injected }
}

/** TOML 文档：codex 风格 model_provider 表（幂等替换我们管理的段） */
export function mergeTomlProvider(configPath, { models, model, token }) {
  let toml = ''
  try { toml = fs.readFileSync(configPath, 'utf-8') } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  let doc
  try { doc = parseToml(toml, { integersAsBigInt: true }) } catch (err) {
    throw new Error(`拒绝覆盖无法解析的 TOML 配置: ${configPath}`, { cause: err })
  }
  const auth = `Bearer ${requireToken(token)}`
  delete doc.model
  doc.model_provider = 'openharness'
  if (model) doc.model = String(model)
  const providers = objectField(doc, 'model_providers')
  providers.openharness = {
    name: 'OpenHarness',
    base_url: PROXY_BASE,
    wire_api: 'chat',
    http_headers: { Authorization: auth }
  }
  doc.model_providers = providers
  const next = stringifyToml(doc, { numbersAsFloat: true })
  try {
    parseToml(next, { integersAsBigInt: true })
  } catch (err) {
    throw new Error(`拒绝写入无效 TOML 配置: ${configPath}`, { cause: err })
  }
  atomicWriteWithBackup(configPath, next)
  return { ok: true, path: configPath, note: 'TOML 已按 parser 标准化写入，原注释/格式可能改变' }
}
