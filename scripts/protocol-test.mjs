// Protocol smoke test: boots the editor link server, plays a fake editor over
// WebSocket, and exercises request, error, and installer paths.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorServer } from '../lib/server.js'
import { installEditorPlugin } from '../lib/installer.js'

const port = 18761
const server = new EditorServer({ host: '127.0.0.1', port, log: () => {} })
await server.start()
console.log(`server listening=${server.listening} port=${server.port}`)

const socket = new WebSocket(`ws://127.0.0.1:${port}`)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.type !== 'req') return
  if (message.method === 'editor.save') {
    socket.send(JSON.stringify({ ver: '1.0', type: 'res', id: message.id, code: 200, result: { saved: 2, method: message.method } }))
  } else if (message.method === 'editor.screenshot') {
    socket.send(JSON.stringify({ ver: '1.0', type: 'res', id: message.id, code: 200, result: { path: 'X:/missing.png' } }))
  } else {
    socket.send(JSON.stringify({ ver: '1.0', type: 'res', id: message.id, code: 404, result: { message: `Unknown method: ${message.method}` } }))
  }
})

socket.send(JSON.stringify({
  ver: '1.0', type: 'evt', method: 'project.info',
  payload: { projectName: 'Demo', projectPath: 'E:/Demo/Demo.uproject', engineVersion: '5.5', pluginVersion: '1.2.15' },
}))
await new Promise(resolve => setTimeout(resolve, 100))

const editors = server.editors()
console.log('editors:', editors.length, editors[0]?.info.projectName, editors[0]?.info.engineVersion)

const ok = await server.request('editor.save', { scope: 'all' }, { timeoutMs: 5000 })
console.log('ok result:', JSON.stringify(ok))

try {
  await server.request('nope.missing', {}, { timeoutMs: 5000 })
  console.log('ERROR: expected a command failure')
} catch (error) {
  console.log('error path:', error.name, error.code, error.message)
}

try {
  await server.request('editor.save', {}, { timeoutMs: 5000, project: 'NoSuchProject' })
  console.log('ERROR: expected project mismatch')
} catch (error) {
  console.log('project pick:', error.message)
}

// Installer against a throwaway project describing UE 5.5.
const dir = mkdtempSync(join(tmpdir(), 'dsh-unreal-'))
mkdirSync(join(dir, 'Content'), { recursive: true })
const uproject = join(dir, 'Demo.uproject')
writeFileSync(uproject, JSON.stringify({ FileVersion: 3, EngineAssociation: '5.5', Modules: [] }, null, '\t'))
const installed = installEditorPlugin({ projectPath: dir, pluginsDir: new URL('../assets/plugins', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1') })
console.log('install:', installed.engine, installed.archive.split(/[\\/]/u).pop(), 'enabled=', installed.enabledInProject)
console.log('uplugin present:', existsSync(join(installed.pluginDir, 'UnrealAgentLink.uplugin')))
console.log('dll present:', existsSync(join(installed.pluginDir, 'Binaries', 'Win64', 'UnrealEditor-UnrealAgentLink.dll')))
const descriptor = JSON.parse(readFileSync(uproject, 'utf8'))
console.log('project plugins:', JSON.stringify(descriptor.Plugins))

socket.close()
server.stop()
console.log('done')
