import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml'
import { readJson, writeJsonWithBackup } from './harnesses/config-file.js'

const exec = promisify(execFile)
const stat = (p) => { try { return fs.lstatSync(p) } catch (e) { if (e.code !== 'ENOENT') throw e; return null } }
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)) }
const location = (p) => stat(p) ? fs.realpathSync(p) : path.join(location(path.dirname(p)), path.basename(p))
const pathKey = (p) => process.platform === 'win32' ? p.toLowerCase() : p

function metadata(dir, fallback = path.basename(dir)) {
  const file = path.join(dir, 'SKILL.md')
  if (!stat(file)?.isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error('需要包含不超过 1 MB 的 SKILL.md 普通文件')
  const content = fs.readFileSync(file, 'utf8')
  const header = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const data = header ? loadYaml(header[1], { schema: JSON_SCHEMA }) : {}
  return { name: typeof data?.name === 'string' ? data.name : fallback, description: typeof data?.description === 'string' ? data.description : '', content }
}

// Reject links rather than copying files outside the selected skill (or following cycles).
function copySkill(source, dest) {
  let bytes = 0, count = 0
  fs.cpSync(source, dest, { recursive: true, errorOnExist: true, force: false, filter(p) {
    if (path.basename(p) === '.git') return false
    const s = fs.lstatSync(p)
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error(`Skill 内含链接或特殊文件，请先整理为普通文件：${p}`)
    bytes += s.size
    if (++count > 10000 || bytes > 100 * 1024 * 1024) throw new Error('单个 Skill 超出 100 MB 或 10000 个文件限制')
    return true
  } })
}

export function createSkillService({ root, home = os.homedir(), env = process.env }) {
  root = path.resolve(root)
  const library = path.join(root, 'library')
  const targetsFile = path.join(root, 'targets.json')
  const defaults = [
    ['claude-code', 'Claude Code', path.join(home, '.claude', 'skills')],
    ['codex', 'Codex', path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills')],
    ['cursor', 'Cursor', path.join(home, '.cursor', 'skills')],
    ['opencode', 'OpenCode', path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'skills')],
    ['agents', '共享 Agents', path.join(home, '.agents', 'skills')],
    ['openclaw', 'OpenClaw', path.join(home, '.openclaw', 'skills')]
  ].map(([id, name, dir]) => ({ id, name, path: path.resolve(dir) }))
  function targets() {
    const saved = readJson(targetsFile)
    if (saved.items !== undefined && !Array.isArray(saved.items)) throw new Error('同步目录配置损坏')
    return [...defaults, ...(saved.items || [])].map(t => ({ ...t, exists: !!stat(t.path) }))
  }
  function item(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效 Skill ID')
    const dir = path.join(library, id)
    if (!stat(dir)?.isDirectory()) throw new Error('Skill 不存在')
    const info = readJson(path.join(dir, 'source.json'))
    if (typeof info.folder !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(info.folder)) throw new Error('Skill 目录名无效')
    return { ...info, id, dir, path: path.join(dir, 'content') }
  }
  function state(skill, target) {
    const dest = path.join(target.path, skill.folder)
    const s = stat(dest)
    if (!s) return 'off'
    if (s.isSymbolicLink() && path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === skill.path) return 'on'
    return 'conflict'
  }
  function list() {
    const allTargets = targets()
    const skills = [], errors = []
    for (const d of stat(library) ? fs.readdirSync(library, { withFileTypes: true }) : []) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      try {
        const s = item(d.name)
        skills.push({ ...s, ...metadata(s.path, s.folder), content: undefined, targets: allTargets.map(t => ({ id: t.id, state: state(s, t) })) })
      } catch (e) { errors.push(`${d.name}: ${e.message}`) }
    }
    return { root, skills, targets: allTargets, errors }
  }
  async function materialize(source, destination) {
    if (!source || !['local', 'git'].includes(source.type)) throw new Error('无效来源')
    if (source.type === 'local') {
      if (typeof source.path !== 'string' || !path.isAbsolute(source.path)) throw new Error('请选择绝对目录路径')
      const real = fs.realpathSync(source.path)
      if (inside(real, root) || inside(root, real)) throw new Error('不能从管理库内部或其上级目录导入')
      metadata(real)
      copySkill(real, destination)
      metadata(destination)
      return
    }
    const url = new URL(source.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Git 来源需为不含凭据的 HTTPS 仓库地址')
    const subdir = source.subdir || ''
    if (typeof subdir !== 'string' || path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes('..')) throw new Error('无效仓库子目录')
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openharness-skill-'))
    try {
      const repo = path.join(temp, 'repo')
      await exec('git', ['-c', `core.hooksPath=${temp}`, '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--', url.href, repo], {
        windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
      })
      const selected = fs.realpathSync(path.join(repo, subdir))
      if (!inside(fs.realpathSync(repo), selected)) throw new Error('Skill 路径超出仓库')
      metadata(selected)
      copySkill(selected, destination)
      metadata(destination)
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  }
  // ponytail: one mutation at a time; use per-skill locks if parallel imports become necessary.
  let busy = false
  async function mutate(fn) {
    if (busy) throw new Error('正在处理 Skill，请稍后重试')
    busy = true
    try { return await fn() } finally { busy = false }
  }
  return {
    list,
    detail(id) { const s = item(id); return { ...s, ...metadata(s.path, s.folder) } },
    scan() {
      const found = [], errors = [], seen = new Set()
      for (const t of targets()) {
        try {
          if (!stat(t.path)) continue
          for (const d of fs.readdirSync(t.path, { withFileTypes: true })) {
            if (d.name.startsWith('.')) continue
            try {
              const p = path.join(t.path, d.name)
              if (!fs.statSync(p).isDirectory()) continue
              const real = fs.realpathSync(p)
              if (inside(root, real) || seen.has(real) || !stat(path.join(real, 'SKILL.md'))) continue
              const m = metadata(real)
              found.push({ path: p, tool: t.name, name: m.name, description: m.description })
              seen.add(real)
            } catch (e) { errors.push(`${t.name}/${d.name}: ${e.message}`) }
          }
        } catch (e) { errors.push(`${t.name}: ${e.message}`) }
      }
      return { found, errors }
    },
    addTarget(input) { return mutate(() => {
      if (!input || typeof input.name !== 'string' || !input.name.trim() || typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new Error('请填写名称并选择绝对目录')
      const p = path.resolve(input.path)
      if (stat(p) && !fs.statSync(p).isDirectory()) throw new Error('同步路径必须为目录')
      const real = location(p), realRoot = location(root)
      if (inside(realRoot, real) || inside(real, realRoot)) throw new Error('同步目录不能与管理库重叠')
      if (targets().some(t => pathKey(location(t.path)) === pathKey(real))) throw new Error('同步目录已存在')
      const saved = readJson(targetsFile)
      writeJsonWithBackup(targetsFile, { items: [...(saved.items || []), { id: randomUUID(), name: input.name.trim().slice(0, 80), path: p }] })
      return list()
    }) },
    removeTarget(id) { return mutate(() => {
      const saved = readJson(targetsFile)
      if (!saved.items?.some(t => t.id === id)) throw new Error('只能删除自定义目录')
      const current = list()
      if (current.errors.length || current.skills.some(s => s.targets.some(t => t.id === id && t.state === 'on'))) throw new Error('请先停用此目录下的已同步 Skill，并处理管理库读取错误')
      writeJsonWithBackup(targetsFile, { items: saved.items.filter(t => t.id !== id) })
      return list()
    }) },
    install(source, folder) { return mutate(async () => {
      if (typeof folder !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(folder) || folder.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(folder)) throw new Error('目录名请使用英文、数字、短横线或下划线，且不能为系统保留名')
      const current = list()
      if (current.errors.length) throw new Error('请先处理管理库读取错误')
      if (current.skills.some(s => s.folder.toLowerCase() === folder.toLowerCase())) throw new Error('管理库中已有同名 Skill')
      fs.mkdirSync(library, { recursive: true })
      const id = randomUUID(), staging = path.join(library, '.' + id)
      fs.mkdirSync(staging)
      try {
        await materialize(source, path.join(staging, 'content'))
        writeJsonWithBackup(path.join(staging, 'source.json'), { folder, source, installedAt: new Date().toISOString() })
        fs.renameSync(staging, path.join(library, id))
      } finally { fs.rmSync(staging, { recursive: true, force: true }) }
      return list()
    }) },
    sync(id, selected) { return mutate(() => {
      const s = item(id), all = targets()
      if (!Array.isArray(selected) || selected.some(id => !all.some(t => t.id === id))) throw new Error('无效同步目标')
      metadata(s.path)
      const physical = new Map()
      for (const t of all) {
        const real = location(t.path)
        if (inside(location(root), real) || inside(real, location(root))) throw new Error('同步目录不能与管理库重叠')
        const key = pathKey(real), existing = physical.get(key)
        if (existing) existing.wanted ||= selected.includes(t.id)
        else physical.set(key, { t, before: state(s, t), wanted: selected.includes(t.id) })
      }
      const changes = [...physical.values()]
      const conflict = changes.find(c => c.wanted && c.before === 'conflict')
      if (conflict) throw new Error(`${conflict.t.name} 已有同名目录，未覆盖；请先手动备份并移走原目录`)
      const applied = []
      try {
        for (const c of changes) {
          const dest = path.join(c.t.path, s.folder)
          if (c.wanted && c.before === 'off') {
            fs.mkdirSync(c.t.path, { recursive: true })
            fs.symlinkSync(s.path, dest, process.platform === 'win32' ? 'junction' : 'dir')
            applied.push({ dest, created: true })
          } else if (!c.wanted && c.before === 'on') {
            fs.unlinkSync(dest)
            applied.push({ dest, created: false })
          }
        }
      } catch (e) {
        const errors = []
        for (const a of applied.reverse()) {
          try { if (a.created) fs.unlinkSync(a.dest); else fs.symlinkSync(s.path, a.dest, process.platform === 'win32' ? 'junction' : 'dir') } catch (undo) { errors.push(undo.message) }
        }
        throw new Error(`${e.message}${errors.length ? `；恢复失败：${errors.join('；')}` : '；已撤销本次同步'}`)
      }
      return list()
    }) },
    update(id) { return mutate(async () => {
      const s = item(id), next = path.join(s.dir, 'next'), previous = path.join(s.dir, 'previous')
      if (stat(next) || stat(previous)) throw new Error('发现上次更新残留，请打开管理库检查 next / previous 后重试')
      try {
        await materialize(s.source, next)
        fs.renameSync(s.path, previous)
        try { fs.renameSync(next, s.path) } catch (e) { fs.renameSync(previous, s.path); throw e }
        fs.rmSync(previous, { recursive: true })
      } finally { fs.rmSync(next, { recursive: true, force: true }) }
      return list()
    }) },
    remove(id) { return mutate(() => {
      const s = item(id)
      // Remove only links pointing to our exact content directory; never recurse into a tool directory.
      for (const t of targets()) if (state(s, t) === 'on') fs.unlinkSync(path.join(t.path, s.folder))
      fs.rmSync(s.dir, { recursive: true })
      return list()
    }) }
  }
}
