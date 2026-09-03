import claudeDesktop from './claude-desktop'
import cursor from './cursor'
import windsurf from './windsurf'
import trae from './trae'
import cherry from './cherry'
import openclaw from './openclaw'
import zcode from './zcode'
import opencode from './opencode'
import hermes from './hermes'
import grokBuild from './grok-build'
import pi from './pi'
import kimiCode from './kimi-code'
import dsh from './dsh'
import minimaxCode from './minimax-code'
import primeAgent from './prime-agent'
import claudeCode from './claude-code'
import codex from './codex'

const adapters = [claudeDesktop, claudeCode, codex, grokBuild, pi, kimiCode, dsh, minimaxCode, primeAgent, cursor, windsurf, trae, zcode, opencode, hermes, openclaw]

export default {
  all: () => adapters,
  get: (id) => adapters.find((a) => a.id === id)
}
