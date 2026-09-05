import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Agent 模型配置写入器（参考 opencodex 的集成格式）。
 * 统一将 OpenHarness 本地代理（http://127.0.0.1:18200/v1）作为自定义 Provider
 * 合并进各 Harness 的模型配置文件：
 *   - JSON 文档（opencode/pi/prime/zcode/openclaw）：provider(V1) + providers(V2) 双块
 *   - YAML 文档（omp/gajae/hermes/minimax/dsh）：providers[V2] 块，可指定嵌套根路径
 *   - TOML 文档（kimi/grok）：codex 风格 model_provider 表
 */

const PROXY_BASE = 'http://127.0.0.1:18200/v1'
const PROXY_TOKEN = 'openharness'
const V2_PACKAGE = '@opencode-ai/ai/providers/openai-compatible'

function isFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function backupAndWrite(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // 目标若是目录（候选路径配错时）直接 copyFile 会 EPERM
  if (isFile(p)) fs.copyFileSync(p, p + '.openharness.bak')
  fs.writeFileSync(p, data, 'utf-8')
}

function readDoc(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return {} }
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
export function mergeJsonAgentProviders(configPath, { models }) {
  const doc = readDoc(configPath)
  const mm = modelMap(models)
  const options = { baseURL: PROXY_BASE, apiKey: PROXY_TOKEN }
  doc.provider = {
    ...(doc.provider || {}),
    openharness: { npm: '@ai-sdk/openai-compatible', name: 'OpenHarness', options, models: mm }
  }
  doc.providers = {
    ...(doc.providers || {}),
    openharness: { package: V2_PACKAGE, name: 'OpenHarness', settings: options, models: mm }
  }
  backupAndWrite(configPath, JSON.stringify(doc, null, 2))
  return { ok: true, path: configPath }
}

/** YAML 文档：在 rootPath（如 ['providers'] 或 ['llm-pi-ai','providers']）下合并 V2 块 */
export function mergeYamlAgentProviders(configPath, { models }, rootPath = ['providers']) {
  let doc = {}
  try { doc = yaml.load(fs.readFileSync(configPath, 'utf-8')) || {} } catch {}
  let node = doc
  for (const key of rootPath.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key]
  }
  const last = rootPath[rootPath.length - 1]
  const current = typeof node[last] === 'object' && node[last] !== null ? node[last] : {}
  node[last] = {
    ...current,
    openharness: {
      package: V2_PACKAGE,
      name: 'OpenHarness',
      settings: { baseURL: PROXY_BASE, apiKey: PROXY_TOKEN },
      models: modelMap(models)
    }
  }
  backupAndWrite(configPath, yaml.dump(doc, { lineWidth: -1, noRefs: true }))
  return { ok: true, path: configPath }
}

/** opencode 形状的 mcp 块：remote（SSE/HTTP）+ local（stdio），合并注入 opencode.json */
export function mergeOpencodeMcp(configPath, servers) {
  const doc = readDoc(configPath)
  const existing = doc.mcp || {}
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
  backupAndWrite(configPath, JSON.stringify(doc, null, 2))
  return { ok: true, path: configPath, injected }
}

/** TOML 文档：codex 风格 model_provider 表（幂等替换我们管理的段） */
export function mergeTomlProvider(configPath, { model }) {
  let toml = ''
  try { toml = fs.readFileSync(configPath, 'utf-8') } catch {}
  if (isFile(configPath)) fs.copyFileSync(configPath, configPath + '.openharness.bak')
  toml = toml.replace(/\[model_providers\.openharness\][\s\S]*?(?=\n\[|$)/g, '')
  toml = toml.replace(/^model_provider\s*=.*$/gm, '')
  toml = toml.replace(/^model\s*=.*$/gm, '')
  const inject =
    `model_provider = "openharness"\n` +
    (model ? `model = "${model}"\n` : '') +
    `\n[model_providers.openharness]\n` +
    `name = "OpenHarness"\n` +
    `base_url = "http://127.0.0.1:18200/v1"\n` +
    `wire_api = "chat"\n` +
    `env_key = "OPENHARNESS_API_KEY"\n`
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, toml.trim() + '\n\n' + inject, 'utf-8')
  return { ok: true, path: configPath }
}
