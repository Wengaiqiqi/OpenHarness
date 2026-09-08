/**
 * 无头测试：验证「模型服务」配置能否真正拿到模型回复。
 * 运行：npx electron test-model.mjs
 * 直接调用生产 chat.js，避免诊断副本与实际行为漂移。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const cfgPath = () => path.join(app.getPath('appData'), 'openharness', 'config.json')

const chatSource = fs.readFileSync(new URL('./src/main/chat.js', import.meta.url), 'utf8')
const { createChatService } = await import('data:text/javascript;base64,' + Buffer.from(chatSource).toString('base64'))
const chat = createChatService()

async function testProvider(provider, level) {
  const model = provider.models?.[0]
  if (!model) return { ok: false, message: '未配置模型' }
  let content = ''
  let reasoning = 0
  const win = {
    isDestroyed: () => false,
    webContents: { send(_channel, chunk) {
      if (chunk.type === 'delta') content += chunk.delta
      if (chunk.type === 'reasoning') reasoning += chunk.delta.length
    } }
  }
  const result = await chat.send(win, {
    sessionId: 'diagnostic', provider, model,
    messages: [{ role: 'user', content: '你好，请用一句话介绍你自己' }],
    thinkingLevel: level
  })
  return { ...result, content, reasoning }
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
