import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as yaml from 'js-yaml'
import { parse as parseToml } from 'smol-toml'
import {
  applyAuth,
  mergeClaudeCodeSettings,
  mergeJsonAgentProviders,
  mergeTomlProvider,
  mergeYamlAgentProviders
} from '../src/main/harnesses/agent-config.js'
import { injectMcpIntoFile, resolveCliCommand, commandExists } from '../src/main/harnesses/base.js'
import claudeCode from '../src/main/harnesses/claude-code.js'
import hermes from '../src/main/harnesses/hermes.js'
import pi from '../src/main/harnesses/pi.js'
import kimi from '../src/main/harnesses/kimi-code.js'
import minimax from '../src/main/harnesses/minimax-code.js'
import prime from '../src/main/harnesses/prime-agent.js'

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openharness-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return (name) => path.join(dir, name)
}

test('Hermes model configuration stays JSON and preserves unrelated fields', async (t) => {
  const p = sandbox(t)('hermes.json')
  fs.writeFileSync(p, '{"keep":true,"providers":{"other":{"name":"existing"}}}')
  await hermes.configureModel.call({ configPath: () => p }, { models: ['m'], token: 'test' })
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(saved.keep, true)
  assert.equal(saved.providers.other.name, 'existing')
  assert.equal(saved.providers.openharness.settings.apiKey, 'test')
})

test('CLI fallback quotes spaced paths and fresh installs do not require config files', async (t) => {
  const file = sandbox(t)
  const executable = file('fake command.cmd')
  fs.writeFileSync(executable, '@echo off\r\n')
  const adapter = { cli: 'openharness-nonexistent-test-command', exeCandidates: [executable], _cliResolved: 'obsolete' }
  assert.equal(await resolveCliCommand(adapter), `"${executable}"`)
  adapter.cli = executable
  assert.equal(await resolveCliCommand(adapter), `"${executable}"`)
  assert.equal(await commandExists(executable), true)
  for (const cli of [pi, kimi, minimax, prime]) {
    const result = await cli.detect.call({ ...adapter, configCandidates: [file('missing.json')] })
    assert.equal(result.installed, true)
    assert.equal(result.exePath, executable)
    assert.equal(result.configPath, null)
  }
})

test('invalid JSON, YAML, and TOML are never overwritten', (t) => {
  const file = sandbox(t)
  const cases = [
    [file('bad.json'), '{ broken', () => mergeJsonAgentProviders(file('bad.json'), { models: ['m'], token: 't' })],
    [file('bad-mcp.json'), '{ broken', () => injectMcpIntoFile(file('bad-mcp.json'), [])],
    [file('bad.yaml'), 'items: [broken', () => mergeYamlAgentProviders(file('bad.yaml'), { models: ['m'], token: 't' })],
    [file('bad.toml'), 'items = [broken', () => mergeTomlProvider(file('bad.toml'), { model: 'm', token: 't' })]
  ]
  for (const [p, original, write] of cases) {
    fs.writeFileSync(p, original)
    assert.throws(write, /拒绝覆盖无法解析/)
    assert.equal(fs.readFileSync(p, 'utf-8'), original)
    assert.equal(fs.existsSync(p + '.openharness.bak'), false)
  }
})

test('writes are atomic and preserve the first backup', (t) => {
  const file = sandbox(t)
  const p = file('agent.json')
  const original = '{"keep":true}'
  fs.writeFileSync(p, original)

  mergeJsonAgentProviders(p, { models: ['one'], model: 'one', token: 'first' })
  mergeJsonAgentProviders(p, { models: ['two'], model: 'two', token: 'second' })

  assert.equal(fs.readFileSync(p + '.openharness.bak', 'utf-8'), original)
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf-8')).provider.openharness.options.apiKey, 'second')
  assert.deepEqual(fs.readdirSync(path.dirname(p)).filter((name) => name.endsWith('.tmp')), [])
})

test('TOML update is scoped, escaped, and CLI-independent', (t) => {
  const file = sandbox(t)
  const p = file('config.toml')
  const original = [
    '# keep root comment',
    'model = "old"',
    'model_provider = "old"',
    '',
    '[other]',
    'model = "keep"',
    'model_provider = "keep"',
    '',
    '[model_providers.openharness]',
    'name = "old"',
    '',
    '[tail]',
    'value = 1 # keep tail comment',
    ''
  ].join('\n')
  fs.writeFileSync(p, original)
  const model = 'safe"\n[attacker]\nkey = "still-a-string'
  const token = 'random"\\token'

  mergeTomlProvider(p, { models: [model], model, token })

  const output = fs.readFileSync(p, 'utf-8')
  const parsed = parseToml(output)
  assert.equal(parsed.model, model)
  assert.equal(parsed.model_provider, 'openharness')
  assert.equal(parsed.other.model, 'keep')
  assert.equal(parsed.other.model_provider, 'keep')
  assert.equal(parsed.tail.value, 1)
  assert.equal(parsed.attacker, undefined)
  assert.equal(parsed.model_providers.openharness.http_headers.Authorization, `Bearer ${token}`)
  assert.equal(output.includes('env_key'), false)
  assert.equal(output.indexOf('model_provider = "openharness"') < output.indexOf('[other]'), true)
  assert.equal(output.match(/\[model_providers\.openharness\]/g)?.length, 1)
})

test('JSON, YAML, and Claude Code receive the supplied token', async (t) => {
  const file = sandbox(t)
  const jsonPath = file('models.json')
  const yamlPath = file('settings.yaml')
  const claudeSettingsPath = file('settings.json')
  const claudeMcpPath = file('.claude.json')
  const claudeOriginal = JSON.stringify({ projects: { 'C:/project': { keep: true } } })
  fs.writeFileSync(claudeMcpPath, claudeOriginal)

  mergeJsonAgentProviders(jsonPath, { models: ['m'], model: 'm', token: 'json-token' })
  mergeYamlAgentProviders(yamlPath, { models: ['m'], model: 'm', token: 'yaml-token' })
  mergeClaudeCodeSettings(claudeSettingsPath, { models: ['m'], model: 'm', token: 'claude-token' })
  assert.equal(JSON.parse(fs.readFileSync(jsonPath)).providers.openharness.settings.apiKey, 'json-token')
  assert.equal(yaml.load(fs.readFileSync(yamlPath, 'utf-8')).providers.openharness.settings.apiKey, 'yaml-token')
  assert.equal(JSON.parse(fs.readFileSync(claudeSettingsPath)).env.ANTHROPIC_AUTH_TOKEN, 'claude-token')

  const oldCandidates = claudeCode.configCandidates
  const oldMcpConfigPath = claudeCode.mcpConfigPath
  t.after(() => {
    claudeCode.configCandidates = oldCandidates
    claudeCode.mcpConfigPath = oldMcpConfigPath
  })
  claudeCode.configCandidates = [claudeSettingsPath]
  claudeCode.mcpConfigPath = () => claudeMcpPath
  await claudeCode.injectMcp([{ name: 'demo', command: 'demo-cli', args: ['serve'] }])
  const claude = JSON.parse(fs.readFileSync(claudeMcpPath, 'utf-8'))
  assert.deepEqual(claude.mcpServers.demo, { command: 'demo-cli', args: ['serve'] })
  assert.deepEqual(claude.projects, { 'C:/project': { keep: true } })
  assert.equal(fs.readFileSync(claudeMcpPath + '.openharness.bak', 'utf-8'), claudeOriginal)
})

test('a missing token is rejected before writing', (t) => {
  const file = sandbox(t)
  const p = file('missing-token.json')
  assert.throws(() => mergeJsonAgentProviders(p, { models: ['m'] }), /token 不能为空/)
  assert.equal(fs.existsSync(p), false)
})

test('YAML scalar roots are preserved and empty mappings remain writable', (t) => {
  const file = sandbox(t)
  const p = file('settings.yaml')
  for (const source of ['false', '0', '""', 'null']) {
    fs.writeFileSync(p, source)
    assert.throws(() => mergeYamlAgentProviders(p, { models: ['m'], token: 't' }), /非对象/)
    assert.equal(fs.readFileSync(p, 'utf8'), source)
    assert.equal(fs.existsSync(p + '.openharness.bak'), false)
  }
  fs.writeFileSync(p, '{}')
  mergeYamlAgentProviders(p, { models: ['m'], token: 't' })
  assert.equal(yaml.load(fs.readFileSync(p, 'utf8')).providers.openharness.settings.apiKey, 't')
})

test('query authentication replaces old credentials and stays before the fragment', () => {
  const result = applyAuth({
    url: 'https://example.test/mcp?key=old&keep=1#section',
    auth: { mode: 'query', key: 'new & key' }
  })
  const url = new URL(result.url)
  assert.deepEqual(url.searchParams.getAll('key'), ['new & key'])
  assert.equal(url.searchParams.get('keep'), '1')
  assert.equal(url.hash, '#section')
})
