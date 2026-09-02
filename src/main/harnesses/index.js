import claudeDesktop from './claude-desktop'
import cursor from './cursor'
import windsurf from './windsurf'
import trae from './trae'
import vscode from './vscode'
import cherry from './cherry'
import openclaw from './openclaw'
import zcode from './zcode'
import opencode from './opencode'
import hermes from './hermes'

const adapters = [claudeDesktop, cursor, windsurf, trae, vscode, zcode, opencode, hermes, cherry, openclaw]

export default {
  all: () => adapters,
  get: (id) => adapters.find((a) => a.id === id)
}
