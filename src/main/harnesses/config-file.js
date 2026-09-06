import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

export function readConfig(p, parse, format) {
  const source = readText(p)
  if (source === null) return {}
  let value
  try {
    value = parse(source)
  } catch (err) {
    throw new Error(`拒绝覆盖无法解析的 ${format} 配置: ${p}`, { cause: err })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`拒绝覆盖非对象 ${format} 配置: ${p}`)
  }
  return value
}

export function readJson(p) {
  return readConfig(p, JSON.parse, 'JSON')
}

export function atomicWriteWithBackup(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  let mode = 0o600
  try {
    const stat = fs.statSync(p)
    if (!stat.isFile()) throw new Error(`配置路径不是文件: ${p}`)
    mode = stat.mode
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  const backup = p + '.openharness.bak'
  try {
    fs.copyFileSync(p, backup, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'EEXIST') throw err
  }

  const temp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, data, { encoding: 'utf-8', flag: 'wx', mode })
    fs.renameSync(temp, p)
  } catch (err) {
    try { fs.unlinkSync(temp) } catch {}
    throw err
  }
}

export function writeJsonWithBackup(p, data) {
  atomicWriteWithBackup(p, JSON.stringify(data, null, 2))
}
