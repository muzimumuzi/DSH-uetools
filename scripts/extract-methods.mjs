// Regenerate assets/methods.json from the UnrealAgentLink C++ command registry.
// Dev-only: run after syncing plugin/UnrealAgentLink from the upstream plugin source.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_ROOT = process.env.UAL_PLUGIN_SOURCE
  ?? 'D:/clone/unreal-agent-link/plugin/UnrealAgentLink/Source/UnrealAgentLink'

const found = new Map()

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    if (!/\.(cpp|h)$/u.test(entry.name)) continue
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/CommandMap\.Add\(TEXT\("([A-Za-z0-9_.]+)"\)/gu)) {
      found.set(match[1], entry.name)
    }
  }
}

walk(SOURCE_ROOT)
const methods = [...found].map(([method, file]) => ({ method, file })).sort((a, b) => a.method.localeCompare(b.method))
writeFileSync(new URL('../assets/methods.json', import.meta.url), `${JSON.stringify(methods, null, 2)}\n`, 'utf8')
console.log(`methods: ${methods.length}`)
