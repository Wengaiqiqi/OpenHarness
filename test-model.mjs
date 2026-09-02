/**
 * 无头测试：验证「模型服务」配置能否真正拿到模型回复。
 * 运行：npx electron test-model.mjs
 * 复刻 chat.js 的请求逻辑（含思考参数候选链降级），逐块打印结果。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const cfgPath = () => path.join(app.getPath('appData'), 'openharness', 'config.json')

function thinkingCandidates(model, level) {
  const m = (model || '').toLowerCase()
  if (/glm|doubao/.test(m)) {
    if (level === 'off') return [{ thinking: { type: 'disabled' } }, { thinking: { type: 'enabled' } }]
    return [{ thinking: { type: 'enabled' } }, { thinking: { type: 'disabled' } }]
  }
  if (/qwen/.test(m)) {
    if (level === 'off') return [{ enable_thinking: false }, {}]
    return [{ enable_thinking: true }, {}]
  }
  if (/deepseek/.test(m)) return [{}]
  if (level === 'off') return [{}, { reasoning_effort: 'low' }]
  return [{ reasoning_effort: level }, {}]
}

async function testProvider(provider, level) {
  const base = provider.baseUrl.replace(/\/+$/, '')
  const model = (provider.models || [])[0]
  if (!model) return { ok: false, message: '未配置模型' }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` }
  const baseBody = { model, messages: [{ role: 'user', content: '你好，请用一句话介绍你自己' }], stream: true, temperature: 0.7 }
  const candidates = thinkingCandidates(model, level)

  let res
  for (let i = 0; i < candidates.length; i++) {
    const body = { ...baseBody, ...candidates[i] }
    console.log(`  尝试候选 ${i + 1}/${candidates.length}:`, JSON.stringify(candidates[i]))
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    if (res.status !== 400 && res.status !== 422) break
    const t = await res.text().catch(() => '')
    console.log(`  候选 ${i + 1} 被拒(HTTP ${res.status}):`, t.slice(0, 160))
  }

  console.log(`  状态: ${res.status}, content-type: ${res.headers.get('content-type')}`)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return { ok: false, message: `HTTP ${res.status}: ${t.slice(0, 300)}` }
  }

  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('event-stream')) {
    const j = await res.json().catch(() => null)
    const text = j?.choices?.[0]?.message?.content || JSON.stringify(j)?.slice(0, 300)
    return { ok: true, content: `[非流式] ${text}` }
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = 0
  const timer = setTimeout(() => { console.log('  [超时 45s 无数据]'); reader.cancel().catch(() => {}) }, 45000)

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const l = line.trim()
      if (!l.startsWith('data:')) continue
      const p = l.slice(5).trim()
      if (p === '[DONE]') { clearTimeout(timer); return { ok: true, content, reasoning } }
      try {
        const j = JSON.parse(p)
        if (j.error) { clearTimeout(timer); return { ok: false, message: 'SSE error: ' + (j.error.message || JSON.stringify(j.error)) } }
        const d = j.choices?.[0]?.delta || {}
        if (d.content) { content += d.content; process.stdout.write('.') }
        if (d.reasoning_content) { reasoning += d.reasoning_content.length; process.stdout.write('·') }
      } catch {}
    }
  }
  clearTimeout(timer)
  return { ok: content.length > 0 || reasoning > 0, content, reasoning }
}

app.whenReady().then(async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'))
    const providers = cfg.providers || []
    if (!providers.length) { console.log('未找到任何已保存的 Provider'); app.quit(); return }
    console.log(`找到 ${providers.length} 个 Provider：`)
    for (const p of providers) console.log(` - ${p.name} [${p.type}] ${p.baseUrl} 模型数:${p.models?.length} Key:${p.apiKey ? '有' : '无'}`)

    for (const p of providers) {
      if (!p.models?.length) { console.log(`\n[${p.name}] 跳过：无模型`); continue }
      console.log(`\n===== 测试 ${p.name}（模型 ${p.models[0]}，思考等级 medium）=====`)
      const r = await testProvider(p, 'medium')
      if (r.ok) {
        console.log(`  ✓ 成功！思考字符数: ${r.reasoning ?? 0}`)
        console.log(`  回答预览: ${(r.content || '').slice(0, 160) || '（无 content，仅有思考）'}`)
      } else {
        console.log(`  ✗ 失败: ${r.message || JSON.stringify(r).slice(0, 200)}`)
      }
    }
  } catch (e) {
    console.log('测试出错:', String(e))
  }
  app.quit()
})
