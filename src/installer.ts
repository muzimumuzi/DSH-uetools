/**
 * Installs the bundled UnrealAgentLink editor plugin into a project.
 *
 * The package ships precompiled archives per Unreal Engine minor version
 * (`assets/plugins/UnrealAgentLink<digits>.zip`, digits like `55`). Installation
 * extracts the matching archive into `<Project>/Plugins/UnrealAgentLink` and
 * enables the plugin in the project's `.uproject`.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { readZip } from './zip.js'

/** One installation request. */
export interface InstallOptions {
  /** `.uproject` file or the project directory. */
  readonly projectPath: string
  /** Engine minor version override, e.g. `5.5`; defaults to the project's EngineAssociation. */
  readonly engineVersion?: string
  /** Package `assets/plugins` directory. */
  readonly pluginsDir: string
  /** Replace an existing plugin directory even when it already looks installed. */
  readonly force?: boolean
}

/** What the installation did. */
export interface InstallResult {
  readonly projectFile: string
  readonly pluginDir: string
  readonly archive: string
  readonly engine: string
  readonly enabledInProject: boolean
  readonly notes: readonly string[]
}

/** Locate the single `.uproject` a path refers to. */
function resolveProjectFile(projectPath: string): string {
  const absolute = resolve(projectPath)
  if (absolute.toLowerCase().endsWith('.uproject')) {
    if (!existsSync(absolute)) throw new Error(`找不到工程文件：${absolute}`)
    return absolute
  }
  if (!existsSync(absolute)) throw new Error(`找不到工程目录：${absolute}`)
  const candidates = readdirSync(absolute).filter(name => name.toLowerCase().endsWith('.uproject'))
  if (candidates.length === 0) throw new Error(`${absolute} 里没有 .uproject 文件`)
  if (candidates.length > 1) throw new Error(`${absolute} 里有多个 .uproject，请直接指定其中一个`)
  return join(absolute, candidates[0] as string)
}

/** Reduce an EngineAssociation / override to the archive's digit pair. */
function engineDigits(engine: string): string {
  const match = /(\d+)\.(\d+)/u.exec(engine)
  if (match !== null) return `${match[1] ?? ''}${match[2] ?? ''}`
  const bare = engine.replace(/\D/gu, '')
  if (bare.length === 2) return bare
  throw new Error(`认不出引擎版本 "${engine}"；请显式传 engineVersion，例如 5.5`)
}

/** Enable the plugin in the project descriptor. */
function enableInProject(projectFile: string, raw: string, data: Record<string, unknown>): boolean {
  const plugins = Array.isArray(data['Plugins']) ? data['Plugins'] as unknown[] : []
  const existing = plugins.find((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && (entry as { Name?: unknown }).Name === 'UnrealAgentLink')
  if (existing !== undefined) {
    if (existing['Enabled'] === true) return false
    existing['Enabled'] = true
  } else {
    plugins.push({ Name: 'UnrealAgentLink', Enabled: true })
  }
  data['Plugins'] = plugins
  const next = `${JSON.stringify(data, null, '\t')}\n`
  if (next !== raw) writeFileSync(projectFile, next, 'utf8')
  return true
}

/**
 * Install the editor plugin for one project.
 *
 * @param options - project, optional engine override, and packaged archives.
 * @returns the project file, plugin directory, archive, and any follow-up notes.
 */
export function installEditorPlugin(options: InstallOptions): InstallResult {
  const projectFile = resolveProjectFile(options.projectPath)
  const raw = readFileSync(projectFile, 'utf8')
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/u, '')) as Record<string, unknown>
  } catch {
    throw new Error(`${projectFile} 不是合法 JSON，无法判断引擎版本`)
  }

  const association = options.engineVersion
    ?? (typeof data['EngineAssociation'] === 'string' ? data['EngineAssociation'] : '')
  if (association === '') {
    throw new Error('这个工程没有 EngineAssociation（源码构建引擎）；请显式传 engineVersion，例如 5.5')
  }
  const digits = engineDigits(association)
  const archive = join(options.pluginsDir, `UnrealAgentLink${digits}.zip`)
  if (!existsSync(archive)) {
    const available = existsSync(options.pluginsDir)
      ? readdirSync(options.pluginsDir).filter(name => name.endsWith('.zip')).map(name => name.replace('UnrealAgentLink', '').replace('.zip', '')).join(', ')
      : '(资产目录缺失)'
    throw new Error(`本插件没有 UE ${association} 的预编译包；已带版本：${available}`)
  }

  // The precompiled archive carries engine binaries, so the version must match
  // exactly. A wrong-version DLL crashes the editor on load instead of failing loud.
  const declared = data['EngineAssociation']
  if (options.engineVersion === undefined && typeof declared === 'string' && !/^\d+\.\d+$/u.test(declared)) {
    throw new Error(`EngineAssociation "${declared}" 不是版本号（源码构建引擎）；请显式传 engineVersion，例如 5.5`)
  }

  const projectDir = dirname(projectFile)
  const pluginDir = join(projectDir, 'Plugins', 'UnrealAgentLink')
  const expected = join(pluginDir, 'UnrealAgentLink.uplugin')
  const notes: string[] = []
  if (existsSync(expected) && options.force !== true) {
    notes.push('插件目录已存在：保留现有文件，只补缺失项')
  } else if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true })
    notes.push('已清空旧的插件目录')
  }

  const entries = readZip(readFileSync(archive))
  let written = 0
  for (const entry of entries) {
    const target = join(pluginDir, ...entry.name.split('/'))
    if (!target.startsWith(pluginDir + sep) && target !== pluginDir) {
      throw new Error(`压缩包条目越界：${entry.name}`)
    }
    if (entry.directory) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    written += 1
  }
  if (!existsSync(expected)) throw new Error(`压缩包里没有 UnrealAgentLink.uplugin：${archive}`)

  const enabled = enableInProject(projectFile, raw, data)
  if (enabled) notes.push('已在 .uproject 里启用 UnrealAgentLink')
  notes.push(`${String(written)} 个文件装进 ${pluginDir}`)
  notes.push('重启编辑器后插件才会加载；编辑器会主动连到本插件监听的 ws 地址')

  return {
    projectFile,
    pluginDir,
    archive,
    engine: association,
    enabledInProject: enabled,
    notes,
  }
}
