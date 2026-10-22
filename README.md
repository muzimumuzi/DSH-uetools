# dsh-unreal

**TL;DR (English)** — A standalone [DeepSeek Harness](https://github.com/deepseek-ai) plugin that drives a running Unreal Engine editor over its own WebSocket link. No Unreal Box app, no MCP bridge, no external process: the package ships the precompiled **UnrealAgentLink** editor plugin for UE 5.0–5.8, runs the link server itself, and exposes **40 native tools** covering **170** editor commands.

用 DSH 直接操作虚幻引擎编辑器：建 Actor、写蓝图、连材质图、跑 PIE、截图回传。**不依赖虚幻盒子**——不需要 `unreal-agent.exe` 运行，也不需要它的 MCP 服务。

```
DSH 工具（40 个）
   └── dsh-unreal 插件（本仓库，Node 内置模块，零依赖）
         └── WebSocket 服务 ws://127.0.0.1:17860   ← 本插件自己监听
               └── UnrealAgentLink（随包分发的 UE 编辑器插件，5.0–5.8 预编译）
                     └── 虚幻编辑器
```

## 为什么单独做一个插件

虚幻盒子把编辑器链路封在 Electron 应用里：编辑器连它的 `17860`，能力再经它的 MCP 服务（Bearer token）暴露给外部。这条路能走通，但每一步都多一个活的进程和一份要同步的状态——应用没开、端口被占、token 过期，工具就全哑了。

本仓库把那层拆掉：**编辑器插件随包发**，**链路服务器自己起**，DSH 工具直接说编辑器的协议。运行时只有 DSH 和虚幻编辑器两个进程。

## 安装

### 1. 装进 DSH

仓库不提交构建产物，先编译并打包：

```sh
cd D:/dsh-uetools
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # 编译 lib/
npm pack                                                       # 产出 dsh-external-dsh-unreal-0.1.0.tgz
```

然后装进 profile：

```sh
cd ~/.dsh/profiles/web
pnpm add "D:/dsh-uetools/dsh-external-dsh-unreal-0.1.0.tgz"
```

在 profile 的 `package.json` 里把包名加进 `dsh.profile.bundles`：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-external/dsh-unreal"]
```

重启 DSH。包自带 `cordis.patch.yml`，装配时插入一条 `id: unreal` 的条目并带上默认配置。

### 2. 装进虚幻工程

在 DSH 里：

```
ue_install_plugin projectPath=E:\Projects\MyGame
```

它按 `.uproject` 的 `EngineAssociation` 选对应引擎版本的预编译包，解压到 `<工程>/Plugins/UnrealAgentLink`，并在 `.uproject` 里启用。**重启编辑器**后插件加载，主动连回 `ws://127.0.0.1:17860`。

### 3. 确认

```
ue_status
```

应看到工程名、路径、引擎版本、插件构建指纹。之后 `ue_call`、`ue_spawn_actor`、`ue_screenshot` 就能用了。

## 工具

### 基础（8）

| 工具 | 作用 |
|---|---|
| `ue_status` | 监听状态、已连接编辑器、命令目录 |
| `ue_install_plugin` | 把编辑器插件装进工程 |
| `ue_call` | 通用入口：方法名 + JSON 参数，直达 170 条命令 |
| `ue_methods` | 列出命令方法（可按关键词过滤） |
| `ue_docs` | 读取随包的 12 份接口文档 |
| `ue_project_info` | 工程全貌（引擎、插件、地图、Python 可用性） |
| `ue_save` | 保存插件改过的对象 |
| `ue_screenshot` | 抓编辑器/PIE 视口，**图片直接进上下文** |

### 高层封装（11）

| 工具 | 作用 |
|---|---|
| `ue_get_actor` | 按 selection / names / paths / filter 选 Actor，返回变换与包围盒 |
| `ue_spawn_actor` | 别名（cube / point_light…）或资产路径批量生成，单位厘米 |
| `ue_set_transform` | set / add / multiply 改位置、旋转、缩放 |
| `ue_destroy_actor` | 删除（先查引用，被引用会拦） |
| `blueprint_apply_graph` | 一次写完一整片蓝图逻辑（节点 + 连线 + 编译） |
| `blueprint_get_graph` | 读图的节点、引脚、连线、坐标 |
| `blueprint_search_nodes` | 查函数/节点的确切名字与引脚签名 |
| `material_apply_graph` | 一次写完材质图（建节点 → 连线 → 排版 → 编译） |
| `material_get_graph` | 读材质图的节点、连线、参数值 |
| `material_search_nodes` | 查材质节点类型的引脚与可设属性 |
| `content_import` | 批量导入模型/贴图，自动 PBR 分组并生成材质实例 |

### 域工具（21，覆盖全部 170 条命令）

每个命令域一个工具，`action` 选动作、`params` 原样转发：

`ue_actor` `ue_blueprint` `ue_material` `ue_content` `ue_level` `ue_editor` `ue_system`
`ue_pcg` `ue_sequence` `ue_widget` `ue_landscape` `ue_pie` `ue_input` `ue_mesh`
`ue_datatable` `ue_cpp` `ue_project` `ue_locks` `ue_messagelog` `ue_viewport` `ue_python`

```jsonc
// 跑 3 秒 PIE
{ "action": "run", "params": { "duration_seconds": 3 } }   // → ue_pie
```

## 配置

`cordis.patch.yml`（可被 profile patch 覆盖）：

```yaml
- id: unreal
  name: '@dsh-external/dsh-unreal'
  config:
    host: 127.0.0.1        # 监听网卡
    port: 17860            # 编辑器连的端口
    requestTimeoutMs: 120000
    screenshotTimeoutMs: 180000
```

编辑器侧的端口可以改：启动参数 `-UALServer=ws://127.0.0.1:<端口>`，同时把这里 `port` 改成同一个。

## 协议

消息是 JSON 文本帧，三个方向：

```jsonc
// 编辑器连上后主动发
{"ver":"1.0","type":"evt","method":"project.info","payload":{...}}

// DSH → 编辑器
{"ver":"1.0","type":"req","id":"req-...","method":"actor.spawn","params":{...}}

// 编辑器 → DSH
{"ver":"1.0","type":"res","id":"req-...","code":200,"result":{...}}
```

`code < 400` 为成功；`>= 400` 时 `result.message` 是编辑器自己的报错，`result.details` 可选。请求按 `id` 配对，超时与取消都会清掉挂起项。

实现上只用 Node 内置模块：WebSocket 服务端（RFC 6455 握手、掩码、分片、ping/pong）在 `src/websocket.ts`，ZIP 解包（central directory + zlib inflate）在 `src/zip.ts`。没有 `ws`，没有 `adm-zip`。

## 边界与安全

- **平台**：随包的编辑器插件二进制只有 **Win64**（UE 5.0–5.8）。macOS/Linux 上 JS 能跑，但没有可装的编辑器插件。
- **鉴权**：链路是回环 WebSocket，**协议本身没有令牌**。本机任意进程都能连上来冒充编辑器，只在本机可信环境使用；不要把 `host` 改成 `0.0.0.0`。
- **版本必须匹配**：预编译二进制与引擎版本严格对应，装错版本会让编辑器加载崩溃。
- **端口唯一**：同一端口只能有一个宿主。和虚幻盒子同时跑必须错开（见上）。
- **未连接不发写操作**：编辑器没连上时工具直接报错，不排队。
- **撤销栈**：`editor.undo` 撤的是插件自己记录的那几步，不是编辑器的全局历史。

## 目录

```
src/websocket.ts   RFC 6455 服务端
src/server.ts      连接管理、请求/响应、工程路由
src/installer.ts   装编辑器插件（解压 + 改 .uproject）
src/zip.ts         ZIP 读取
src/wrappers.ts    高层封装 + 域工具
src/index.ts       插件入口、基础工具
assets/plugins/    9 个引擎版本的预编译插件
assets/docs/       12 份接口文档
assets/methods.json 170 条命令目录
```

## 开发

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # 编译 src → lib
npm test                                                       # 协议 + 安装器冒烟
node scripts/extract-methods.mjs                               # 从插件源码重生成命令目录
```

`scripts/build.sh` 只借用 checkout 里的 `tsc` 和类型链接，产物不依赖它。发布前 `npm pack` 会按 `files` 打包 `lib`、`assets`、`cordis.patch.yml` 与许可文件。

## 许可

- 本仓库代码：BSD-3-Clause，见 [`LICENSE`](LICENSE)。
- 随包的 UnrealAgentLink 编辑器插件与接口文档：Apache-2.0，来自 [ueboxai/uebox](https://github.com/ueboxai/uebox)，全文见 [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt) 与 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
