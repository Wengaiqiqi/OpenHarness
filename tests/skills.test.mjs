import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSkillService } from '../src/main/skills.js'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openharness-skills-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const options = { root: path.join(dir, 'managed'), home: path.join(dir, 'home'), env: {} }
  const service = createSkillService(options)
  const source = path.join(dir, 'example')
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: Example\ndescription: |\n  Multiline description\n---\n# Hello')
  fs.writeFileSync(path.join(source, 'scripts', 'run.py'), 'print("example")')
  return { service, options, source, dir }
}

test('import, multi-tool sync, reload, update, disable and removal preserve the original', async t => {
  const { service, options, source } = setup(t)
  let result = await service.install({ type: 'local', path: source }, 'example')
  const id = result.skills[0].id
  assert.match(result.skills[0].description, /Multiline/)
  assert.equal(fs.readFileSync(path.join(result.skills[0].path, 'scripts/run.py'), 'utf8'), 'print("example")')
  result = await service.sync(id, ['claude-code', 'codex'])
  const target = path.join(result.targets.find(t => t.id === 'codex').path, 'example')
  assert.equal(fs.realpathSync(target), fs.realpathSync(result.skills[0].path))
  const reloaded = createSkillService(options)
  assert.equal(reloaded.list().skills[0].targets.filter(t => t.state === 'on').length, 2)
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: Updated\n---\nNew content')
  await reloaded.update(id)
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /New content/)
  await reloaded.sync(id, ['codex'])
  assert.equal(reloaded.list().skills[0].targets.filter(t => t.state === 'on').length, 1)
  await reloaded.remove(id)
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.existsSync(path.join(source, 'SKILL.md')), true)
  assert.equal(reloaded.list().skills.length, 0)
})

test('conflicts never overwrite original or unrelated links, even during deletion', async t => {
  const { service, source } = setup(t)
  const { skills, targets } = await service.install({ type: 'local', path: source }, 'example')
  const target = path.join(targets[0].path, 'example')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
  await assert.rejects(service.sync(skills[0].id, ['claude-code', 'codex']), /同名/)
  assert.equal(service.list().skills[0].targets.filter(t => t.state === 'on').length, 0)
  const foreign = path.join(targets[1].path, 'example')
  fs.mkdirSync(targets[1].path, { recursive: true })
  fs.symlinkSync(source, foreign, process.platform === 'win32' ? 'junction' : 'dir')
  await service.remove(skills[0].id)
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(fs.existsSync(foreign), true)
})

test('a failed sync rolls back previously created links and can be retried', async t => {
  const { service, source, dir } = setup(t)
  const result = await service.install({ type: 'local', path: source }, 'example')
  const added = await service.addTarget({ name: 'Custom', path: path.join(dir, 'custom') })
  const id = result.skills[0].id
  const symlink = fs.symlinkSync
  let calls = 0
  fs.symlinkSync = (...args) => { if (++calls === 2) throw new Error('mock link permission failure'); return symlink(...args) }
  try { await assert.rejects(service.sync(id, ['codex', added.targets.at(-1).id]), /已撤销/) } finally { fs.symlinkSync = symlink }
  assert.equal(calls, 2)
  assert.equal(fs.existsSync(path.join(result.targets.find(t => t.id === 'codex').path, 'example')), false)
  await service.sync(id, ['codex'])
  assert.equal(service.list().skills[0].targets.find(t => t.id === 'codex').state, 'on')
})

test('aliased tool roots share one link and custom directories persist and can be removed', async t => {
  const { service, source, options, dir } = setup(t)
  const claude = path.join(options.home, '.claude', 'skills'), codex = path.join(options.home, '.codex', 'skills')
  fs.mkdirSync(claude, { recursive: true })
  fs.mkdirSync(path.dirname(codex), { recursive: true })
  fs.symlinkSync(claude, codex, process.platform === 'win32' ? 'junction' : 'dir')
  const { skills } = await service.install({ type: 'local', path: source }, 'example')
  const result = await service.sync(skills[0].id, ['claude-code', 'codex'])
  assert.equal(result.skills[0].targets.filter(t => t.state === 'on').length, 2)
  const custom = await service.addTarget({ name: 'Project', path: path.join(dir, 'project', '.agents', 'skills') })
  const id = custom.targets.at(-1).id
  assert.equal(createSkillService(options).list().targets.at(-1).id, id)
  await service.sync(skills[0].id, [id])
  await assert.rejects(service.removeTarget(id), /停用/)
  await service.sync(skills[0].id, [])
  await service.removeTarget(id)
  assert.equal(service.list().targets.some(t => t.id === id), false)
})

test('invalid update preserves old content and scan does not rediscover managed links', async t => {
  const { service, source, options } = setup(t)
  const result = await service.install({ type: 'local', path: source }, 'example')
  const id = result.skills[0].id
  await service.sync(id, ['codex'])
  assert.equal(service.scan().found.length, 0)
  const external = path.join(options.home, '.claude', 'skills', 'existing')
  fs.mkdirSync(external, { recursive: true })
  fs.copyFileSync(path.join(source, 'SKILL.md'), path.join(external, 'SKILL.md'))
  assert.equal(service.scan().found[0].path, external)
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: [bad\n---\n')
  await assert.rejects(service.update(id))
  assert.match(service.detail(id).content, /Hello/)
  assert.equal(service.list().skills[0].targets.find(t => t.id === 'codex').state, 'on')
})

test('boundary validation rejects traversal, duplicate names, embedded links and unsafe Git URLs', async t => {
  const { service, source, dir } = setup(t)
  for (const name of ['../escape', 'a/b', 'CON', 'trailing.']) await assert.rejects(service.install({ type: 'local', path: source }, name))
  await service.install({ type: 'local', path: source }, 'example')
  await assert.rejects(service.install({ type: 'local', path: source }, 'EXAMPLE'), /同名/)
  assert.throws(() => service.detail('../escape'))
  for (const url of ['file:///tmp/repo', 'https://user:pass@github.com/a/b', 'ssh://host/a/b']) {
    await assert.rejects(service.install({ type: 'git', url }, 'git-example'))
  }
  await assert.rejects(service.install({ type: 'git', url: 'https://github.com/a/b', subdir: '../escape' }, 'git-example'))
  const external = path.join(dir, 'outside')
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(external, 'secret'), 'do not copy')
  fs.symlinkSync(external, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(service.install({ type: 'local', path: source }, 'linked-example'), /链接/)
  assert.equal(service.list().skills.length, 1)
})

test('corrupt target config is reported rather than overwritten', async t => {
  const { service, options } = setup(t)
  fs.mkdirSync(options.root, { recursive: true })
  const file = path.join(options.root, 'targets.json')
  fs.writeFileSync(file, '{bad')
  await assert.rejects(service.addTarget({ name: 'custom', path: path.join(options.home, 'custom') }))
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad')
})
