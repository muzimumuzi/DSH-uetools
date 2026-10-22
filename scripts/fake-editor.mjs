// Fake UnrealAgentLink editor: connects to the plugin's endpoint, reports a
// project, and answers the commands the live smoke test uses. Stays up briefly.
import { writeFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 17860)
const shotPath = process.argv[3] ?? 'E:/dsh-plugins/dsh-unreal/tmp-shot.png'
// 2x2 red PNG so the attachment store has real decodable bytes.
writeFileSync(shotPath, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMQkYGBgBFDQIB9t3nVwAAAABJRU5ErkJggg==',
  'base64',
))

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
ws.addEventListener('open', () => {
  console.log('fake editor connected')
  ws.send(JSON.stringify({
    ver: '1.0', type: 'evt', method: 'project.info',
    payload: { projectName: 'DemoGame', projectPath: 'E:/Demo/DemoGame.uproject', engineVersion: '5.5', pluginVersion: '1.2.15', pluginBuild: 'fake' },
  }))
})
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.type !== 'req') return
  console.log('command', message.method, JSON.stringify(message.params ?? {}))
  let result
  switch (message.method) {
    case 'editor.save':
      result = { saved: 3, scope: message.params?.scope ?? 'touched' }
      break
    case 'editor.screenshot':
      result = { path: shotPath, width: 2, height: 2 }
      break
    case 'project.info':
      result = { projectName: 'DemoGame', projectPath: 'E:/Demo/DemoGame.uproject', engineVersion: '5.5', currentLevel: '/Game/Maps/Main' }
      break
    default:
      ws.send(JSON.stringify({ ver: '1.0', type: 'res', id: message.id, code: 404, result: { message: `Unknown method: ${message.method}` } }))
      return
  }
  ws.send(JSON.stringify({ ver: '1.0', type: 'res', id: message.id, code: 200, result }))
})
ws.addEventListener('close', () => console.log('fake editor closed'))
setTimeout(() => { ws.close(); process.exit(0) }, 240_000)
