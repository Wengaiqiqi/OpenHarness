import claudeDesktop from './claude-desktop'
import cursor from './cursor'
import windsurf from './windsurf'
import trae from './trae'
import vscode from './vscode'
import cherry from './cherry'
import openclaw from './openclaw'

const adapters = [claudeDesktop, cursor, windsurf, trae, vscode, cherry, openclaw]

export default {
  all: () => adapters,
  get: (id) => adapters.find((a) => a.id === id)
}
