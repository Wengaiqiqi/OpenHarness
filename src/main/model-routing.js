// Rebuild routing from saved selections and current provider credentials.
export function buildModelRoutes(history, providers) {
  const routes = new Map()
  for (const entry of Object.values(history || {})) {
    for (const item of entry.items || []) {
      const provider = providers.find((p) => p.id === item.providerId)
      if (!provider) continue
      if (typeof item.model !== 'string' || !item.model.trim() || /[\x00-\x1f\x7f]/.test(item.model)) {
        throw new Error('模型名称不能为空或包含控制字符')
      }
      const previous = routes.get(item.model)
      if (previous && previous.provider.id !== provider.id) {
        throw new Error(`模型 ${item.model} 已分配给另一提供商，请先取消原配置中的同名模型`)
      }
      routes.set(item.model, { provider, model: item.model })
    }
  }
  return [...routes.values()]
}
