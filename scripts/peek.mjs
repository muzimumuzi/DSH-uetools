import { existsSync, readFileSync } from 'node:fs'

const root = 'D:/clone/uebox/src/main/agent-v3/tools/'
const files = [
  'adapted/ue-blueprint/searchNodes.ts',
  'ue-material/searchNodes.ts',
  'adapted/ue-content-browser/importAssets.ts',
]
for (const file of files) {
  const path = root + file
  if (!existsSync(path)) {
    console.log('MISSING', file)
    continue
  }
  const text = readFileSync(path, 'utf8')
  const index = text.lastIndexOf('callRequest')
  console.log(`=== ${file} ===`)
  console.log(text.slice(Math.max(0, index - 800), index + 600))
}
