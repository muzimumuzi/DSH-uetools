/**
 * Editor link server: accepts UnrealAgentLink connections, keeps their project
 * identity, and multiplexes JSON requests over them.
 *
 * Wire protocol (implemented by the UE plugin, `UAL_CommandHandler.cpp`):
 * - editor → host event: `{ver:'1.0', type:'evt', method:'project.info', payload:{...}}`
 * - host → editor request: `{ver:'1.0', type:'req', id, method, params}`
 * - editor → host response: `{ver:'1.0', type:'res', id, code, result}`
 *
 * `code` is HTTP-like: below 400 is success, at or above 400 carries
 * `result.message` (and optional `result.details`).
 *
 * @module
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { acceptWebSocket } from './websocket.js'
import type { WsConnection } from './websocket.js'

/** Project identity reported by the editor right after connecting. */
export interface EditorInfo {
  readonly projectName?: string
  readonly projectPath?: string
  readonly engineVersion?: string
  readonly pluginVersion?: string
  readonly pluginBuild?: string
  readonly [key: string]: unknown
}

/** Read-only view of one live editor connection. */
export interface EditorSnapshot {
  readonly id: string
  readonly remote: string
  readonly connectedAt: string
  readonly info: EditorInfo
}

/** Error carrying the editor's own status code. */
export class EditorCommandError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'EditorCommandError'
  }
}

/** One pending request waiting for its response. */
interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/** Internal connection state. */
interface Connection {
  readonly id: string
  readonly ws: WsConnection
  readonly openedAt: string
  info: EditorInfo
  readonly pending: Map<string, PendingRequest>
}

/** Server options. */
export interface EditorServerOptions {
  readonly host: string
  readonly port: number
  readonly log: (message: string) => void
}

/** Request options. */
export interface RequestOptions {
  /** Project path or name fragment used to pick one editor. */
  readonly project?: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** Resolved request payload from the editor. */
export type CommandResult = Record<string, unknown>

/** Monotonic request counter, unique per process. */
let requestCounter = 0

/** Extract a human-readable message from the editor's error envelope. */
function errorMessage(code: number, result: Record<string, unknown>): string {
  const message = result['message']
  return typeof message === 'string' && message !== '' ? message : `editing command failed with code ${String(code)}`
}

/** Editor link server. */
export class EditorServer {
  private server: Server | undefined
  private readonly connections = new Map<string, Connection>()
  private counter = 0

  constructor(private readonly options: EditorServerOptions) {}

  /** Editors seen since startup, still connected. */
  editors(): EditorSnapshot[] {
    return [...this.connections.values()].map(connection => ({
      id: connection.id,
      remote: connection.ws.remote,
      connectedAt: connection.openedAt,
      info: connection.info,
    }))
  }

  /** Whether the server socket is listening. */
  get listening(): boolean {
    return this.server?.listening === true
  }

  /** Bound port, or 0 before start. */
  get port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address !== null ? address.port : 0
  }

  /**
   * Bind the editor endpoint.
   *
   * @throws when the port is taken by another process.
   */
  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('WebSocket endpoints only: start Unreal Engine with the UnrealAgentLink plugin enabled.\n')
    })
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Duplex, head)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (error.code === 'EADDRINUSE') {
          reject(new Error(
            `端口 ${String(this.options.port)} 已被占用。`
            + '二选一：关掉占用它的程序，或者用 -UALServer=ws://127.0.0.1:<另一个端口> 启动编辑器，并把本插件 port 配成同一个。',
          ))
          return
        }
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port, this.options.host)
    })
    this.server = server
    this.options.log(`ue: listening on ws://${this.options.host}:${String(this.port)}`)
  }

  /** Stop listening and close every editor connection. */
  stop(): void {
    for (const connection of this.connections.values()) {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('editor link server stopped'))
      }
      connection.pending.clear()
      connection.ws.close(1001, 'server stopping')
    }
    this.connections.clear()
    this.server?.close()
    this.server = undefined
  }

  /** Handle one HTTP upgrade as a WebSocket editor connection. */
  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.counter += 1
    const id = `editor-${String(this.counter)}`
    let connection: Connection | undefined
    try {
      const ws = acceptWebSocket(req, socket, {
        onMessage: (text) => { this.handleMessage(id, text) },
        onClose: () => { this.dropConnection(id) },
      })
      connection = { id, ws, openedAt: new Date().toISOString(), info: {}, pending: new Map() }
      this.connections.set(id, connection)
      this.options.log(`ue: editor connected (${String(id)}) from ${ws.remote}`)
    } catch (error: unknown) {
      this.options.log(`ue: rejected upgrade: ${error instanceof Error ? error.message : String(error)}`)
      socket.destroy()
      return
    }
    if (head.length > 0) socket.unshift(head)
  }

  /** Route one inbound message: editor events and command responses. */
  private handleMessage(connectionId: string, text: string): void {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      message = parsed as Record<string, unknown>
    } catch {
      this.options.log(`ue: dropped malformed message from ${connectionId}`)
      return
    }

    const type = message['type']
    if (type === 'evt') {
      const method = message['method']
      if (method === 'project.info') {
        const payload = message['payload']
        connection.info = typeof payload === 'object' && payload !== null ? payload as EditorInfo : {}
        this.options.log(`ue: ${String(connection.info.projectName ?? 'project')} ready (${String(connection.info.projectPath ?? 'unknown path')})`)
      }
      return
    }
    if (type !== 'res') return

    const id = message['id']
    if (typeof id !== 'string') return
    const pending = connection.pending.get(id)
    if (pending === undefined) return
    connection.pending.delete(id)
    clearTimeout(pending.timer)

    const code = typeof message['code'] === 'number' ? message['code'] : 200
    const result = typeof message['result'] === 'object' && message['result'] !== null
      ? message['result'] as Record<string, unknown>
      : {}
    if (code >= 400) {
      pending.reject(new EditorCommandError(code, errorMessage(code, result), result['details']))
      return
    }
    pending.resolve(result)
  }

  /** Forget a closed connection and fail everything waiting on it. */
  private dropConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    this.connections.delete(connectionId)
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('编辑器连接已断开（可能是编辑器关闭、重启或崩溃）'))
    }
    connection.pending.clear()
    this.options.log(`ue: editor disconnected (${connectionId})`)
  }

  /** Pick the editor a request targets. */
  private pick(project: string | undefined): Connection {
    const all = [...this.connections.values()]
    if (all.length === 0) {
      throw new Error(
        '没有已连接的虚幻编辑器：先在目标工程里启用 UnrealAgentLink 插件并打开编辑器'
        + `（编辑器会连到 ws://${this.options.host}:${String(this.options.port)}）。`,
      )
    }
    if (project === undefined || project === '') {
      if (all.length === 1) return all[0] as Connection
      const names = all.map(connection => `${String(connection.info.projectName ?? '未命名')} (${String(connection.info.projectPath ?? '?')})`).join('；')
      throw new Error(`同时连着 ${String(all.length)} 个编辑器，请用 project 参数点名：${names}`)
    }
    const needle = project.toLowerCase().replaceAll('\\', '/')
    const matches = all.filter((connection) => {
      const path = String(connection.info.projectPath ?? '').toLowerCase().replaceAll('\\', '/')
      const name = String(connection.info.projectName ?? '').toLowerCase()
      return path.includes(needle) || name.includes(needle)
    })
    if (matches.length === 1) return matches[0] as Connection
    if (matches.length === 0) throw new Error(`没有匹配 "${project}" 的编辑器连接`)
    throw new Error(`"${project}" 匹配到多个编辑器，请写更完整的工程路径`)
  }

  /**
   * Send one command to an editor and wait for its response.
   *
   * @param method - plugin method name, e.g. `actor.get`.
   * @param params - JSON parameters for the command.
   * @param options - target project, timeout, and cancellation.
   * @returns the editor's result object.
   */
  async request(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<CommandResult> {
    const connection = this.pick(options.project)
    requestCounter += 1
    const id = `req-${Date.now().toString(36)}-${String(requestCounter)}`
    const payload = JSON.stringify({ ver: '1.0', type: 'req', id, method, params })
    return await new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id)
        reject(new Error(`命令 ${method} 超时（${String(options.timeoutMs)}ms）；编辑器可能仍在执行，先核实再重发。`))
      }, options.timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        connection.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`命令 ${method} 已被取消`))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      connection.pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      connection.ws.send(payload)
    })
  }
}
