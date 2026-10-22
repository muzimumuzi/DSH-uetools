/**
 * Unreal Engine bridge — drives a running editor through the bundled
 * UnrealAgentLink plugin without any external application.
 *
 * The plugin runs a WebSocket endpoint on loopback; UnrealAgentLink (installed
 * into the project from this package's precompiled archives) connects out to it
 * and answers JSON commands. Tools expose that protocol: a generic `ue_call`
 * for the full 170-method surface, plus file/document helpers and a screenshot
 * path that turns editor captures into DSH image attachments.
 *
 * Runtime dependencies: none beyond Node built-ins. The harness is reached
 * through `ctx` (tool registry, attachment store, logger).
 *
 * @module @dsh-external/dsh-unreal
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { installEditorPlugin, type InstallResult } from './installer.js'
import { registerDomainTools, registerWrappers } from './wrappers.js'
import { EditorCommandError, EditorServer } from './server.js'

/** Cordis identity for this plugin. */
export const name = '@dsh-external/dsh-unreal'

/** The tool registry is mandatory; attachments are resolved opportunistically. */
export const inject = ['tools']

/** Default port the editor plugin dials (`ws://127.0.0.1:17860`). */
const DEFAULT_PORT = 17_860

/** Plugin configuration as written in cordis.yml. */
export interface Config {
  /** Loopback interface to bind (default `127.0.0.1`). */
  host?: string
  /** WebSocket port the editor dials (default 17860). */
  port?: number
  /** Default command timeout in milliseconds (default 120000). */
  requestTimeoutMs?: number
  /** Screenshot timeout in milliseconds (default 180000). */
  screenshotTimeoutMs?: number
  /** Alternate assets directory (archives + docs). */
  assetsDir?: string
}

/** Resolved configuration. */
interface ResolvedConfig {
  readonly host: string
  readonly port: number
  readonly requestTimeoutMs: number
  readonly screenshotTimeoutMs: number
  readonly assetsDir: string
}

/** Validate and default one raw config value. */
function resolveConfig(config: Config | undefined): ResolvedConfig {
  const raw = config ?? {}
  const host = raw.host ?? '127.0.0.1'
  const port = raw.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh-unreal: port must be an integer between 1 and 65535')
  }
  const requestTimeoutMs = raw.requestTimeoutMs ?? 120_000
  const screenshotTimeoutMs = raw.screenshotTimeoutMs ?? 180_000
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error('dsh-unreal: requestTimeoutMs must be a finite number >= 1000')
  }
  if (!Number.isFinite(screenshotTimeoutMs) || screenshotTimeoutMs < 1000) {
    throw new Error('dsh-unreal: screenshotTimeoutMs must be a finite number >= 1000')
  }
  return {
    host,
    port,
    requestTimeoutMs,
    screenshotTimeoutMs,
    assetsDir: raw.assetsDir ?? fileURLToPath(new URL('../assets/', import.meta.url)),
  }
}

/** One bundled command method. */
interface MethodEntry {
  readonly method: string
  readonly file: string
}

/** Opaque content block shape accepted by the tool runtime. */
type Block = ContentBlock

/** Build one text block. */
function textBlock(text: string): Block {
  return { type: 'text', text }
}

/** Narrow an unknown value to a string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Stringify a command result without flooding the context. */
function present(value: unknown, limit = 300_000): string {
  const text = JSON.stringify(value, null, 2) ?? '(空结果)'
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（结果被截断，共 ${String(text.length)} 字符；改用更窄的查询）`
}

/** Attachment store surface this plugin uses. */
interface AttachmentSink {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly { attachmentId: unknown }[]>
}

/** One prepared image projection staged for an exact execution. */
interface StagedProjection {
  readonly value: unknown
  readonly fallback: Block[]
  readonly content: Block[]
}

/** Build one tool definition whose canonical value is a string. */
function stringTool(spec: {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (args: Record<string, unknown>, exec: ToolExecution) => Promise<string>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' } as never,
      render: (_args: unknown, value: unknown): Block[] => [textBlock(String(value))],
    },
    execute: async (args: unknown, exec: ToolExecution): Promise<unknown> => spec.execute(asRecord(args), exec),
  }
}

/**
 * Register every tool. `server` is created before tools so a bind failure is a
 * status line, not a missing tool set.
 */
function registerTools(
  ctx: Context,
  server: EditorServer,
  config: ResolvedConfig,
  startError: () => string | undefined,
): void {
  const register = (definition: ToolDefinition): void => {
    ctx.effect(() => ctx.tools.register(definition), `dsh-unreal: ${definition.name}`)
  }

  const methodsFile = join(config.assetsDir, 'methods.json')
  const loadMethods = (): MethodEntry[] => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(methodsFile, 'utf8'))
      return Array.isArray(parsed) ? parsed as MethodEntry[] : []
    } catch {
      return []
    }
  }
  let methods: MethodEntry[] | undefined

  register(stringTool({
    name: 'ue_status',
    description: '虚幻引擎连接状态：本插件监听的地址、已连接的编辑器与工程、可用命令数量、安装失败原因。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const editors = server.editors()
      const lines = [
        `监听：${server.listening ? `ws://${config.host}:${String(server.port)}` : '未监听'}${startError() === undefined ? '' : `（${startError() ?? ''}）`}`,
        `已连接编辑器：${String(editors.length)} 个`,
      ]
      for (const editor of editors) {
        lines.push(`- ${String(editor.info.projectName ?? '未命名')} | ${String(editor.info.projectPath ?? '?')} | UE ${String(editor.info.engineVersion ?? '?')} | 插件 ${String(editor.info.pluginVersion ?? editor.info.pluginBuild ?? '?')}`)
      }
      if (editors.length === 0) {
        lines.push('没有连接时：确认工程里装了 UnrealAgentLink（用 ue_install_plugin），然后打开编辑器。')
      }
      const known = loadMethods().length
      lines.push(`命令目录：${String(known)} 个方法（ue_methods 查名字，ue_docs 查接口文档，ue_call 直接调）`)
      return lines.join('\n')
    },
  }))

  register(stringTool({
    name: 'ue_install_plugin',
    description: '把随插件分发的 UnrealAgentLink 编辑器插件装进指定 UE 工程（解压对应引擎版本的预编译包并在 .uproject 里启用）。装完重启编辑器即可连上。',
    parameters: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '工程目录或 .uproject 路径。' },
        engineVersion: { type: 'string', description: '可选：引擎版本，如 5.5；缺省读 .uproject 的 EngineAssociation。' },
        force: { type: 'boolean', description: '清空已有插件目录后重装。' },
      },
      required: ['projectPath'],
    },
    async execute(args) {
      const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : ''
      if (projectPath === '') throw new Error('projectPath 必填')
      const result: InstallResult = installEditorPlugin({
        projectPath,
        ...typeof args['engineVersion'] === 'string' ? { engineVersion: args['engineVersion'] } : {},
        pluginsDir: join(config.assetsDir, 'plugins'),
        ...args['force'] === true ? { force: true } : {},
      })
      return [
        `工程：${result.projectFile}`,
        `引擎：${result.engine}`,
        `插件：${result.pluginDir}`,
        `压缩包：${result.archive}`,
        ...result.notes.map(note => `- ${note}`),
      ].join('\n')
    },
  }))

  register(stringTool({
    name: 'ue_call',
    description: '向已连接的虚幻编辑器发一条命令（插件方法名 + JSON 参数），返回编辑器原样结果。方法名与参数约定见 ue_methods / ue_docs。',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: '方法名，如 actor.get / blueprint.apply_graph。' },
        params: { type: 'object', description: '命令参数对象，缺省为 {}。' },
        project: { type: 'string', description: '同时连着多个编辑器时用来点名（工程路径或名字片段）。' },
        timeoutMs: { type: 'integer', description: '可选超时（毫秒）。' },
      },
      required: ['method'],
    },
    async execute(args, exec) {
      const method = typeof args['method'] === 'string' ? args['method'] : ''
      if (method === '') throw new Error('method 必填')
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : config.requestTimeoutMs
      try {
        const result = await server.request(method, asRecord(args['params']), {
          ...typeof args['project'] === 'string' ? { project: args['project'] } : {},
          timeoutMs,
          signal: exec.signal,
        })
        return present(result)
      } catch (error: unknown) {
        if (error instanceof EditorCommandError) {
          throw new Error(`${error.message}（code ${String(error.code)}）${error.details === undefined ? '' : `\n${present(error.details)}`}`)
        }
        throw error
      }
    },
  }))

  register(stringTool({
    name: 'ue_methods',
    description: '列出 UnrealAgentLink 提供的命令方法（可带关键词过滤），用来配合 ue_call 调用尚未封装成原生工具的能力。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按方法名子串过滤，如 blueprint. 或 actor。' },
        limit: { type: 'integer', description: '返回条数上限，默认 60。' },
      },
    },
    async execute(args) {
      methods ??= loadMethods()
      const needle = typeof args['query'] === 'string' ? args['query'].toLowerCase() : ''
      const limit = Math.max(1, Math.min(typeof args['limit'] === 'number' ? args['limit'] : 60, 400))
      const found = methods.filter(entry => needle === '' || entry.method.toLowerCase().includes(needle))
      if (found.length === 0) return `没有匹配 "${needle}" 的方法（共 ${String(methods.length)} 个）。`
      const listed = found.slice(0, limit).map(entry => `${entry.method}  (${entry.file})`)
      return `${listed.join('\n')}${found.length > limit ? `\n…共 ${String(found.length)} 个，已列 ${String(limit)} 个` : ''}`
    },
  }))

  register(stringTool({
    name: 'ue_docs',
    description: '列出或读取随插件分发的接口文档（Actor、蓝图、材质、关卡、编辑器、内容管理…）。调 ue_call 之前用它查参数。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文档名（可不带 .md）；省略则列出全部。' },
      },
    },
    async execute(args) {
      const docsDir = join(config.assetsDir, 'docs')
      if (!existsSync(docsDir)) throw new Error(`文档目录不存在：${docsDir}`)
      const docs = readdirSync(docsDir).filter(file => file.endsWith('.md'))
      const requested = typeof args['name'] === 'string' ? args['name'] : ''
      if (requested === '') return ['随包文档：', ...docs.map(file => `- ${file.replace(/\.md$/u, '')}`), '', '用 ue_docs name=<名字> 读全文。'].join('\n')
      const match = docs.find(file => file === requested || file === `${requested}.md` || file.includes(requested))
      if (match === undefined) throw new Error(`没有匹配 "${requested}" 的文档`)
      const full = join(docsDir, match)
      const text = readFileSync(full, 'utf8')
      return text.length <= 200_000 ? text : `${text.slice(0, 200_000)}\n…（文档被截断）`
    },
  }))

  // Screenshot keeps the image: the editor writes a PNG path into its result, and
  // the bytes are admitted through the attachment store so the model can look at it.
  const staged = new WeakMap<object, StagedProjection>()
  const screenshot: ToolDefinition = {
    name: 'ue_screenshot',
    description: '抓取虚幻编辑器当前视口（PIE 在跑时抓游戏画面）成图片，直接进上下文。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '多编辑器时点名。' },
        resolution: { type: 'array', items: { type: 'integer' }, description: '可选 [宽, 高]，默认 1920×1080。' },
        showUi: { type: 'boolean', description: '连编辑器界面一起抓（需要窗口可见）。' },
        world: { type: 'string', description: 'auto（默认）| editor：PIE 跑着时抓编辑器世界。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
        required: ['path', 'bytes'],
        additionalProperties: false,
      } as never,
      render(_args: unknown, value: unknown): Block[] {
        const shot = value as { path?: string; bytes?: number }
        return [textBlock(`截图：${shot.path ?? ''}（${String(shot.bytes ?? 0)} 字节）`)]
      },
    },
    async execute(args: unknown, exec: ToolExecution): Promise<unknown> {
      const input = asRecord(args)
      const resolution = Array.isArray(input['resolution'])
        ? (input['resolution'] as unknown[]).filter((item): item is number => typeof item === 'number')
        : [1920, 1080]
      const result = await server.request('editor.screenshot', {
        resolution: resolution.length === 2 ? resolution : [1920, 1080],
        ...input['showUi'] === true ? { show_ui: true } : {},
        ...typeof input['world'] === 'string' ? { world: input['world'] } : {},
      }, {
        ...typeof input['project'] === 'string' ? { project: input['project'] } : {},
        timeoutMs: config.screenshotTimeoutMs,
        signal: exec.signal,
      })
      const path = typeof result['path'] === 'string' ? result['path'] : ''
      if (path === '' || !existsSync(path)) throw new Error(`编辑器没有给出可读的截图路径：${present(result)}`)
      const bytes = statSync(path).size
      const value = { path, bytes }
      const fallback = [textBlock(`截图：${path}（${String(bytes)} 字节）`)]
      const attachments = ctx.get('attachments') as AttachmentSink | undefined
      if (attachments === undefined) {
        staged.set(exec, { value, fallback, content: fallback })
        return value
      }
      try {
        const [ref] = await attachments.saveImages([{ data: readFileSync(path), mediaType: 'image/png', name: 'ue-screenshot.png' }])
        staged.set(exec, {
          value,
          fallback,
          content: ref === undefined
            ? fallback
            : [textBlock(`截图：${path}`), { type: 'image', attachment: ref } as unknown as Block],
        })
      } catch (error: unknown) {
        staged.set(exec, {
          value,
          fallback,
          content: [textBlock(`截图已生成但进不了上下文：${error instanceof Error ? error.message : String(error)}\n${path}`)],
        })
      }
      return value
    },
    projectContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): Block[] | undefined {
      const projection = staged.get(exec)
      if (projection === undefined) return undefined
      staged.delete(exec)
      if (result.isError) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
      return projection.content
    },
  }
  ctx.effect(() => ctx.tools.register(screenshot), 'dsh-unreal: ue_screenshot')

  register(stringTool({
    name: 'ue_save',
    description: '把关卡/资质的改动落盘（默认只存本插件改过的对象）。变更在编辑器内存里，不保存就丢。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '多编辑器时点名。' },
        scope: { type: 'string', description: '可选：all 或 touched（默认，插件自己的账）。' },
      },
    },
    async execute(args, exec) {
      const result = await server.request('editor.save', {
        ...typeof args['scope'] === 'string' ? { scope: args['scope'] } : {},
      }, {
        ...typeof args['project'] === 'string' ? { project: args['project'] } : {},
        timeoutMs: config.requestTimeoutMs,
        signal: exec.signal,
      })
      return present(result)
    },
  }))

  register(stringTool({
    name: 'ue_project_info',
    description: '读取已连接工程的完整信息（名称、路径、引擎版本、插件构建指纹、当前关卡等）。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '多编辑器时点名。' },
      },
    },
    async execute(args, exec) {
      const result = await server.request('project.info', {}, {
        ...typeof args['project'] === 'string' ? { project: args['project'] } : {},
        timeoutMs: config.requestTimeoutMs,
        signal: exec.signal,
      })
      return present(result)
    },
  }))
}

/**
 * Start the editor endpoint and register the tool surface.
 *
 * @param ctx - plugin context providing the tool registry.
 * @param config - raw plugin configuration from cordis.yml.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = resolveConfig(config)
  let error: string | undefined
  const server = new EditorServer({
    host: resolved.host,
    port: resolved.port,
    log: message => { ctx.logger.info(message) },
  })
  registerTools(ctx, server, resolved, () => error)
  const register = (definition: ToolDefinition): void => {
    ctx.effect(() => ctx.tools.register(definition), `dsh-unreal: ${definition.name}`)
  }
  registerWrappers({
    server,
    timeoutMs: resolved.requestTimeoutMs,
    assetsDir: resolved.assetsDir,
    register,
  })
  registerDomainTools({
    server,
    timeoutMs: resolved.requestTimeoutMs,
    assetsDir: resolved.assetsDir,
    register,
  })

  ctx.effect(() => {
    server.start().catch((reason: unknown) => {
      error = reason instanceof Error ? reason.message : String(reason)
      ctx.logger.warn(`dsh-unreal: ${error}`)
    })
    return () => server.stop()
  }, 'dsh-unreal: editor link')

  ctx.logger.info(`dsh-unreal: assets=${resolved.assetsDir}`)
}

// Referenced for the type-only import above; the command error class is part of
// the public surface tools report to the model.
export { EditorCommandError } from './server.js'
