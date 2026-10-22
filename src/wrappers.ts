/**
 * High-level editor tools: the ergonomic wrappers that used to live only in the
 * Unreal Box agent. Each one maps a model-facing schema onto one plugin command
 * and keeps the command names out of the model's way.
 *
 * Wrappers stay thin on purpose: the editor plugin owns validation and the
 * authoritative result, so these add schemas, defaults, and readable output —
 * never a second implementation of graph editing.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EditorServer } from './server.js'

/** Small helper shared with the plugin entry. */
export interface WrapperHost {
  readonly server: EditorServer
  readonly timeoutMs: number
  readonly assetsDir: string
  readonly register: (definition: ToolDefinition) => void
}

/** Build one text-output tool. */
function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>, host: WrapperHost) => Promise<unknown>,
  host: WrapperHost,
): void {
  host.register({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' } as never,
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args: unknown) => run(
      typeof args === 'object' && args !== null ? args as Record<string, unknown> : {},
      host,
    ),
  })
}

/** Stringify a result without flooding the context. */
function present(value: unknown, limit = 200_000): string {
  const text = JSON.stringify(value, null, 2) ?? '(空结果)'
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（结果被截断，共 ${String(text.length)} 字符）`
}

/** Forward one command to the editor and return its result. */
async function send(
  host: WrapperHost,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return await host.server.request(method, params, { timeoutMs: host.timeoutMs })
}

/** Actor selector object, shared by get/set/destroy. */
const SELECTOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    selection: { type: 'boolean', description: '当前选中的 Actor。' },
    names: { type: 'array', items: { type: 'string' }, description: '按 Label 精确匹配。' },
    paths: { type: 'array', items: { type: 'string' }, description: '按对象路径精确匹配。' },
    filter: {
      type: 'object',
      additionalProperties: false,
      properties: {
        class: { type: 'string', description: '类名包含匹配（忽略大小写）。' },
        name_pattern: { type: 'string', description: '名称通配符，如 SM_*。' },
        exclude_classes: { type: 'array', items: { type: 'string' }, description: '排除的类名（全等）。' },
      },
    },
  },
  description: '选哪些 Actor：selection / names / paths / filter 至少给一个。',
}

/** Transform delta object used by set_transform operations. */
const TRANSFORM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: { type: 'object', description: '{x,y,z}，单位厘米。' },
    rotation: { type: 'object', description: '{pitch,yaw,roll}，单位度。' },
    scale: { type: 'object', description: '{x,y,z}，倍数。' },
  },
}

/** One graph node for blueprints; extra keys pass through to the plugin. */
const BLUEPRINT_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: '本次调用内的局部 id，连线用它引用。' },
    class: { type: 'string', description: '节点类型：Event / Function / VariableGet / Branch / Cast / Sequence / SpawnActor / Timeline / ForEachLoop / CustomEvent …' },
    member_name: { type: 'string', description: '成员名：函数写 Class.Function，事件写 ReceiveBeginPlay，变量写变量名。' },
    pin_defaults: { type: 'object', description: '引脚字面量，如 {"InString":"Hello"}。已连线引脚不能再设默认值。' },
    settings: { type: 'object', description: '细节面板设置（动画节点/状态机用）。' },
    position: { type: 'object', description: '{x,y} 坐标；省略则自动布局。' },
    timeline: { type: 'object', description: 'Timeline 节点的时长/轨道设置。' },
  },
  required: ['id', 'class'],
}

/** Connection between two graph nodes. */
const CONNECTION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    from: { type: 'string', description: '源「节点id.引脚名」，如 begin.then。' },
    to: { type: 'string', description: '目标「节点id.引脚名」，如 print.execute。' },
  },
  required: ['from', 'to'],
}

/** One material node. */
const MATERIAL_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: '局部 id，连线引用它。' },
    node_type: { type: 'string', description: '节点类型，如 Constant3Vector / TextureSample / Lerp / Multiply。' },
    node_name: { type: 'string', description: '参数节点的参数名。' },
    value: { description: '常量/参数节点初始值；ComponentMask 用 "RGB" 这类字符串。' },
    texture_path: { type: 'string', description: 'TextureSample 的贴图路径。' },
    function_path: { type: 'string', description: 'MaterialFunctionCall 的函数资产路径。' },
    collection_path: { type: 'string', description: 'CollectionParameter 的 MPC 路径。' },
    group_name: { type: 'string', description: '参数分组名。' },
    properties: { type: 'object', description: '节点细节设置（C++ 属性名 → 值）。' },
  },
  required: ['id', 'node_type'],
}

/**
 * Register every high-level wrapper.
 *
 * @param host - editor server, timeout, and the registration sink.
 */
export function registerWrappers(host: WrapperHost): void {
  tool(
    'ue_get_actor',
    '查询当前关卡里的 Actor：找到它们、读位置/属性/包围盒。targets 里给 selection、names、paths 或 filter。',
    {
      type: 'object',
      properties: {
        targets: SELECTOR_SCHEMA,
        limit: { type: 'integer', description: '最多返回多少个，默认 50。' },
        return_transform: { type: 'boolean', description: '是否返回位置/旋转/缩放，默认 true。' },
        return_bounds: { type: 'boolean', description: '是否返回包围盒尺寸。' },
        include_system_actors: { type: 'boolean', description: '是否包含引擎内部 Actor，默认 false。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['targets'],
    },
    async (args, h) => present(await send(h, 'actor.get_info', prune({
      targets: args['targets'],
      limit: args['limit'],
      return_transform: args['return_transform'],
      return_bounds: args['return_bounds'],
      include_system_actors: args['include_system_actors'],
    }))),
    host,
  )

  tool(
    'ue_spawn_actor',
    '在场景里创建 Actor。asset_id 支持别名（cube / sphere / cylinder / cone / plane / point_light / spot_light / directional_light / rect_light / camera）或资产路径。**单位是厘米**：米×100。可批量传 instances。',
    {
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          description: '批量创建（一次最多 50 个）。给了它就忽略顶层单参数。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              asset_id: { type: 'string', description: '别名或资产路径。' },
              name: { type: 'string', description: 'Actor 名字。' },
              transform: TRANSFORM_SCHEMA,
              location: { type: 'object', description: '{x,y,z} 厘米。' },
              rotation: { type: 'object', description: '{pitch,yaw,roll} 度。' },
              scale: { type: 'object', description: '{x,y,z} 倍数。' },
            },
          },
        },
        asset_id: { type: 'string', description: '单个创建时的别名或路径。' },
        name: { type: 'string', description: '单个创建时的名字。' },
        transform: TRANSFORM_SCHEMA,
        location: { type: 'object' },
        rotation: { type: 'object' },
        scale: { type: 'object' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
    },
    async (args, h) => present(await send(h, 'actor.spawn', prune({
      instances: args['instances'],
      asset_id: args['asset_id'],
      name: args['name'],
      transform: args['transform'],
      location: args['location'],
      rotation: args['rotation'],
      scale: args['scale'],
    }))),
    host,
  )

  tool(
    'ue_set_transform',
    '改 Actor 的位置/旋转/缩放。operation 里给 set（绝对值）、add（增量）或 multiply（倍乘），坐标单位厘米、旋转单位度。',
    {
      type: 'object',
      properties: {
        targets: SELECTOR_SCHEMA,
        operation: {
          type: 'object',
          additionalProperties: true,
          description: 'space: World|Local；snap_to_floor；set/add/multiply 各含 location/rotation/scale。',
          properties: {
            space: { type: 'string', enum: ['World', 'Local'] },
            snap_to_floor: { type: 'boolean' },
            set: TRANSFORM_SCHEMA,
            add: TRANSFORM_SCHEMA,
            multiply: TRANSFORM_SCHEMA,
          },
        },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['targets', 'operation'],
    },
    async (args, h) => present(await send(h, 'actor.set_transform', prune({
      targets: args['targets'],
      operation: args['operation'],
    }))),
    host,
  )

  tool(
    'ue_destroy_actor',
    '删除 Actor。targets 用 names/paths/filter/selection 选中；会先查引用，被引用时会拦下来。',
    {
      type: 'object',
      properties: {
        targets: SELECTOR_SCHEMA,
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['targets'],
    },
    async (args, h) => present(await send(h, 'actor.destroy', prune({ targets: args['targets'] }))),
    host,
  )

  tool(
    'blueprint_apply_graph',
    '一次写完一整片蓝图逻辑：新建 nodes 里的全部节点、按 connections 连好线、编译。连线写「节点id.引脚名」；局部 id 由插件映射成真实节点。先想清楚整张图再发一次，不要逐个节点加。',
    {
      type: 'object',
      properties: {
        blueprint_path: { type: 'string', description: '蓝图路径，如 /Game/Tests/BP_Test。' },
        graph_name: { type: 'string', description: '图表名，默认 EventGraph；函数图/事件图需先建。' },
        nodes: { type: 'array', items: BLUEPRINT_NODE_SCHEMA, description: '这一批要建的节点。' },
        connections: { type: 'array', items: CONNECTION_SCHEMA, description: '节点之间的连线。' },
        clear_existing: { type: 'boolean', description: '先清空图里现有节点再写。' },
        compile: { type: 'boolean', description: '写完是否编译，默认 true。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['blueprint_path', 'nodes'],
    },
    async (args, h) => present(await send(h, 'blueprint.create_graph', prune({
      blueprint_path: args['blueprint_path'],
      graph_name: args['graph_name'],
      nodes: args['nodes'],
      connections: args['connections'],
      clear_existing: args['clear_existing'],
      compile: args['compile'],
    }))),
    host,
  )

  tool(
    'blueprint_get_graph',
    '读一张蓝图图的完整内容：节点、引脚、连线、坐标。写图/改图之前先用它看清楚现状。',
    {
      type: 'object',
      properties: {
        blueprint_path: { type: 'string', description: '蓝图路径。' },
        graph_name: { type: 'string', description: '图表名，默认 EventGraph。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['blueprint_path'],
    },
    async (args, h) => present(await send(h, 'blueprint.get_graph', prune({
      blueprint_path: args['blueprint_path'],
      graph_name: args['graph_name'],
    }))),
    host,
  )

  tool(
    'blueprint_search_nodes',
    '查蓝图节点类型/函数的确切名字与引脚签名。写图之前必须先用它查，别猜 member_name。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键字，如 PrintString、SpawnActor。' },
        limit: { type: 'integer', description: '返回条数上限。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['query'],
    },
    async (args, h) => present(await send(h, 'blueprint.search_nodes', prune({
      query: args['query'],
      limit: args['limit'],
    }))),
    host,
  )

  tool(
    'material_apply_graph',
    '一次写完一张材质图：新建全部节点、连好线、排版、编译。连线写「节点id.引脚名」，材质主节点写 "Material.BaseColor" 这类。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '材质资产路径，如 /Game/Materials/M_Test。' },
        nodes: { type: 'array', items: MATERIAL_NODE_SCHEMA, description: '这次要新建的节点。' },
        connections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string', description: '源「节点id.引脚名」，如 tex.RGB。' },
              to: { type: 'string', description: '目标，主节点写 Material.BaseColor。' },
            },
            required: ['from', 'to'],
          },
        },
        tidy: { type: 'boolean', description: '自动排版，默认 true。' },
        compile: { type: 'boolean', description: '自动编译，默认 true。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['path', 'nodes'],
    },
    async (args, h) => {
      // The editor exposes node-level material commands, so a whole graph is
      // added node by node and then wired; ids are resolved here because the
      // caller only knows its local ids.
      const materialPath = typeof args['path'] === 'string' ? args['path'] : ''
      if (materialPath === '') throw new Error('path 必填')
      const nodes = Array.isArray(args['nodes']) ? args['nodes'] as Record<string, unknown>[] : []
      const connections = Array.isArray(args['connections'])
        ? args['connections'] as { from?: unknown; to?: unknown }[]
        : []
      const ids = new Map<string, string>()
      const created: { local: unknown; node_id: string }[] = []
      for (const node of nodes) {
        const response = await send(h, 'material.add_node', prune({
          material_path: materialPath,
          node_type: node['node_type'],
          node_name: node['node_name'],
          initial_value: node['value'],
          texture_path: node['texture_path'],
          function_path: node['function_path'],
          collection_path: node['collection_path'],
          group_name: node['group_name'],
          properties: node['properties'],
          position: node['position'],
        })) as Record<string, unknown>
        const nodeId = typeof response['node_id'] === 'string' ? response['node_id'] : ''
        ids.set(String(node['id']), nodeId)
        created.push({ local: node['id'], node_id: nodeId })
      }
      const resolve = (ref: unknown): { node: string; pin: string } => {
        const text = String(ref)
        const dot = text.lastIndexOf('.')
        if (dot < 0) return { node: text, pin: '' }
        const local = text.slice(0, dot)
        return { node: ids.get(local) ?? local, pin: text.slice(dot + 1) }
      }
      let wired = 0
      for (const connection of connections) {
        const from = resolve(connection.from)
        const to = resolve(connection.to)
        await send(h, 'material.connect_pins', {
          material_path: materialPath,
          source_node: from.node,
          source_pin: from.pin,
          target_node: to.node,
          target_pin: to.pin,
        })
        wired += 1
      }
      const compile = args['compile'] !== false
      const compiled = compile
        ? await send(h, 'material.compile', { path: materialPath })
        : undefined
      return present({ material_path: materialPath, created, connections: wired, compiled })
    },
    host,
  )

  tool(
    'material_get_graph',
    '读一张材质图的节点、引脚、连线与参数。改图之前先看现状。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '材质资产路径。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['path'],
    },
    async (args, h) => present(await send(h, 'material.get_graph', prune({ path: args['path'] }))),
    host,
  )

  tool(
    'material_search_nodes',
    '查材质节点类型的引脚签名与可设属性。写材质图之前先用它查引脚名（TextureSample 的 UV 叫 Coordinates，别猜）。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '节点类型或关键字，如 TextureSample。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['query'],
    },
    async (args, h) => present(await send(h, 'material.search_nodes', prune({ query: args['query'] }))),
    host,
  )

  tool(
    'content_import',
    '把磁盘上的模型/贴图批量导入工程（自动 PBR 分组、生成材质实例）。files 是绝对路径。',
    {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '要导入的绝对文件路径。' },
        destination_path: { type: 'string', description: '工程内目标目录，如 /Game/Characters。' },
        project: { type: 'string', description: '多编辑器时点名。' },
      },
      required: ['files'],
    },
    async (args, h) => present(await send(h, 'content.import', prune({
      files: args['files'],
      destination_path: args['destination_path'],
    }))),
    host,
  )
}

/** Drop undefined keys so the editor sees only explicit parameters. */
function prune(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined))
}

/** Human labels for the 170-method command domains. */
const DOMAIN_LABELS: Record<string, string> = {
  actor: '场景 Actor',
  blueprint: '蓝图',
  cmd: 'Python',
  content: '内容与资产',
  cpp: 'C++ 编译',
  datatable: '数据表',
  editor: '编辑器',
  input: '输入映射与注入',
  landscape: '地形',
  level: '关卡',
  locks: '资产锁',
  material: '材质',
  messagelog: '消息日志',
  mesh: '网格',
  pcg: 'PCG 程序化内容',
  pie: 'PIE 运行与观测',
  project: '工程设置',
  sequence: 'Sequencer 过场',
  system: '系统与控制台',
  viewport: '视口',
  widget: 'UMG 控件',
}

/** One bundled command method, as written by `scripts/extract-methods.mjs`. */
interface MethodEntry {
  readonly method: string
  readonly file: string
}

/** Read the bundled method catalog. */
function loadMethods(assetsDir: string): MethodEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(assetsDir, 'methods.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed as MethodEntry[] : []
  } catch {
    return []
  }
}

/**
 * Register one native tool per command domain (`ue_pcg`, `ue_sequence`, …).
 *
 * One schema per domain keeps all 170 methods reachable without putting 170
 * function declarations in every request: `action` selects the method and
 * `params` is forwarded unchanged.
 *
 * @param host - editor server, timeout, assets, and the registration sink.
 */
export function registerDomainTools(host: WrapperHost): void {
  const byDomain = new Map<string, string[]>()
  for (const entry of loadMethods(host.assetsDir)) {
    const dot = entry.method.indexOf('.')
    if (dot <= 0) continue
    const domain = entry.method.slice(0, dot)
    const action = entry.method.slice(dot + 1)
    if (action === '') continue
    const actions = byDomain.get(domain) ?? []
    actions.push(action)
    byDomain.set(domain, actions)
  }
  for (const [domain, actions] of byDomain) {
    const sorted = [...actions].sort()
    const label = DOMAIN_LABELS[domain] ?? domain
    const name = domain === 'cmd' ? 'ue_python' : `ue_${domain}`
    tool(
      name,
      `虚幻引擎「${label}」命令：action 选动作（${sorted.join(' / ')}），params 原样转发给编辑器。参数细节用 ue_docs 查对应接口文档。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: sorted, description: '要执行的动作。' },
          params: { type: 'object', additionalProperties: true, description: '动作参数，原样转发。' },
          project: { type: 'string', description: '多编辑器时点名（工程路径或名字片段）。' },
        },
        required: ['action'],
      },
      async (args, h) => {
        const action = typeof args['action'] === 'string' ? args['action'] : ''
        if (!sorted.includes(action)) {
          throw new Error(`未知动作 ${action}；可选：${sorted.join(', ')}`)
        }
        const params = typeof args['params'] === 'object' && args['params'] !== null
          ? args['params'] as Record<string, unknown>
          : {}
        const project = typeof args['project'] === 'string' ? args['project'] : undefined
        const result = await h.server.request(`${domain}.${action}`, params, {
          timeoutMs: h.timeoutMs,
          ...project === undefined ? {} : { project },
        })
        return present(result)
      },
      host,
    )
  }
}
