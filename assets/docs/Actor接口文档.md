## actor.spawn v2.0 （全能生成）


- **Method**：`actor.spawn`
- **Params**：
  - `instances`: 数组，支持单体/批量统一入口。每个元素：
    - `asset_id`: 推荐字段，智能解析三级回落：
      1) 别名（内置）：`cube` `sphere` `cylinder` `cone` `plane` `point_light` `spot_light` `directional_light` `rect_light` `camera`
      2) 资源路径：如 `/Game/Environment/Props/SM_Table_01.SM_Table_01`（静态网格自动生成 `AStaticMeshActor` 并绑定 Mesh）；或蓝图类路径 `/Game/BP_Enemy.BP_Enemy_C`（直接 Spawn 类）
      3) 类名：如 `BP_Enemy_C` 或 `/Script/Engine.PointLight`
    - 兼容字段：`preset`（旧别名）、`class`（旧类路径）
    - `name`：可选，强制命名
    - `mesh`：可选，覆盖静态网格路径（优先级高于解析出的 Mesh）
    - `transform`：可选对象，或顶层字段 `location/rotation/scale`（向后兼容）
      - `location` `{x,y,z}`，`rotation` `{pitch,yaw,roll}`，`scale` `{x,y,z}`
  - 兼容：旧字段 `batch` 会被转为 `instances`
- **Response**：
  - `count`: 成功创建数量
  - `created`: 数组，对应输入顺序，失败位置为 `null`
    - `name`，`path`，`class`
    - `asset_id`（若输入使用 asset_id）
    - `type`（解析出的类型名）
    - `preset`（若走了别名）
- **示例**：
```json
{
  "ver": "2.0",
  "method": "actor.spawn",
  "params": {
    "instances": [
      { "asset_id": "point_light", "transform": { "location": { "z": 500 } } },
      { "asset_id": "/Game/Environment/Props/SM_Table_01.SM_Table_01", "transform": { "location": { "x": 200 } } },
      { "asset_id": "/Game/Blueprints/Characters/BP_NPC_Guard.BP_NPC_Guard_C", "name": "Guard_01", "transform": { "location": { "x": -200 }, "rotation": { "yaw": 90 } } }
    ]
  }
}
```
```json
{
  "code": 200,
  "result": {
    "count": 3,
    "created": [
      { "name": "PointLight_4", "type": "PointLight" },
      { "name": "SM_Table_01_2", "type": "StaticMeshActor" },
      { "name": "Guard_01", "type": "BP_NPC_Guard_C" }
    ]
  }
}
```


## actor.get_info v2.0 （场景感知 / 统一 Selector）

- **Method**：`actor.get_info`
- **Params**：
  - `targets`: 对象（复用 `actor.set_transform` / `actor.destroy` 选择器）
    - `names`: 可选，字符串数组，按 Label 精准查找
    - `paths`: 可选，字符串数组，按对象路径查找
    - `filter`: 可选，场景扫描筛选
      - `class`: 类名包含匹配（模糊，忽略大小写）
      - `name_pattern`: 名称通配匹配（Wildcard）
      - `exclude_classes`: 数组，排除类名（全等匹配，忽略大小写）
  - `return_transform`: `true`/`false`，默认 `true`。返回 `transform`（location/rotation/scale），若只想看列表可置 `false` 节省 Token。
  - `return_bounds`: `true`/`false`，默认 `false`。返回组件包围盒尺寸 `bounds {x,y,z}`（堆叠/避障需要尺寸时再开）。
  - `limit`: 整数，默认 `50`，限制返回数量保护上下文。
  - `include_system_actors`: `true`/`false`，默认 `false`。见下方「系统 Actor」。
- **Response**：
  - `count`: 实际返回的数量（受 limit 截断）
  - `total_found`: 真实匹配总数（可提示还有更多；**已扣除**被隐藏的系统 Actor）
  - `actors`: 数组
    - 基础：`name`, `class`, `path`
    - 可选：`transform`（`location/rotation/scale`，需 `return_transform=true`）、`bounds`（需 `return_bounds=true`）
  - `system_actors_excluded`: 整数，被隐藏的系统 Actor 数量。**为 0 时不返回这个字段**
  - `system_actors_by_class`: 对象，按真实类名分组的计数，如 `{ "WorldPartitionHLOD": 144 }`。
    键名可以直接抄进 `filter.exclude_classes`

### 系统 Actor 默认不列出

扫描（只给 `filter`，没给 `names`/`paths`/`selection`）时，引擎自己的记账对象默认不进结果集：

| 类名 | 为什么在表里 |
|---|---|
| `WorldPartitionHLOD` | World Partition 烘出来的合并代理网格，一个大世界上百个，改了下次 Build HLOD 就冲掉 |
| `LODActor` | 非 World Partition 关卡的老式 HLOD 代理，同上 |
| `RecastNavMesh*` | NavMeshBoundsVolume 的**生成产物**（用户放的是 Volume，不在表里） |
| `AbstractNavData` | 没有真实导航数据时的占位物，纯内部对象 |
| `NavigationDataChunkActor` | World Partition 下按 Cell 切开的导航数据载体 |
| `DefaultPhysicsVolume` | 每个世界自带一个的兜底物理体积，用户没放它也删不掉 |
| `GameplayDebugger*` | 调试 HUD 的网络复制载体，随调试器开关自动增删 |
| `WorldPartitionMiniMap*` | 小地图的烘焙目标与取景体积，编辑器工具链产物 |
| `WorldDataLayers` | Data Layer 的容器 Actor，一个世界一个 |
| `LevelInstanceEditorInstanceActor` | 编辑关卡实例时临时挂出的变换代理（`LevelInstance` 本体不在表里） |

规则：

- **过滤发生在 `limit` 截断之前**。否则 144 个 HLOD 会先把 50 条的额度吃光，
  再从残渣里过滤 —— 等于没过滤。
- **只对扫描生效**。按 `names`/`paths` 点名、或 `selection` 取当前选中时一律照给：
  调用方点名要一个 HLOD，那就是真的想要它。
- **隐藏了多少一定回报**（`system_actors_excluded`）。静默过滤会让调用方以为
  「场景里就这些」并据此下结论，那是比满屏 HLOD 更难查的一类错。
- 传 `include_system_actors: true` 可以把它们全要回来，一条不少。

判据是一张具名表（`UAL_CommandUtils.cpp` 里的 `SystemActorRules`），按**类名字符串**匹配
而不是 `UClass` 指针：这份源码要同时编过 5.0–5.8，表里几个类在老版本上根本不存在
（如 `WorldPartitionMiniMapVolume`），拿指针就得加版本分支和模块依赖，
按名字匹配则「查无此类 = 不匹配」，天然安全。

- **示例 1：精准查询（椅子还在吗？在哪？）**
```json
{
  "ver": "2.0",
  "method": "actor.get_info",
  "params": {
    "targets": {
      "names": ["Chair_01"]
    },
    "return_transform": true
  }
}
```

- **示例 2：环境扫描（看看有哪些灯，最多 5 个）**
```json
{
  "ver": "2.0",
  "method": "actor.get_info",
  "params": {
    "targets": {
      "filter": {
        "class": "Light"
      }
    },
    "limit": 5,
    "return_transform": true
  }
}
```

- **示例响应**
```json
{
  "code": 200,
  "result": {
    "count": 2,
    "total_found": 15,
    "actors": [
      {
        "name": "PointLight_1",
        "class": "PointLight",
        "path": "/Game/Maps/Level1.PointLight_1",
        "transform": {
          "location": { "x": 100, "y": 200, "z": 300 },
          "rotation": { "pitch": 0, "yaw": 0, "roll": 0 },
          "scale": { "x": 1, "y": 1, "z": 1 }
        }
      },
      {
        "name": "SpotLight_Hallway",
        "class": "SpotLight",
        "path": "/Game/Maps/Level1.SpotLight_Hallway",
        "transform": {
          "location": { "x": 500, "y": 200, "z": 300 },
          "rotation": { "pitch": 0, "yaw": 0, "roll": 0 },
          "scale": { "x": 1, "y": 1, "z": 1 }
        }
      }
    ]
  }
}
```

---

## actor.inspect v2.0 （按需内省 / 防止 Token 爆炸）

- **Method**：`actor.inspect`
- **Params**：
  - `targets`: 对象（统一 Selector，推荐单体，也可批量）
    - `names/paths/filter` 同 `actor.get_info`
  - `properties`: 字符串数组；为空/缺省时使用默认白名单
    - 默认白名单：`Mobility`, `bHidden`, `CollisionProfileName`, `Tags`
  - `include_system_actors`: `true`/`false`，默认 `false`。规则与回报字段同 `actor.get_info`
    （见上方「系统 Actor 默认不列出」）。内省这条路更受不了它们 ——
    每个 Actor 还要带一组属性值，144 个 HLOD 足够把上下文顶穿。
- **Response**：
  - `count`: 返回的 actor 数量
  - `actors`: 数组
    - `name`, `class`, `path`
    - `props`: 仅包含请求的属性键值
  - `system_actors_excluded` / `system_actors_by_class`: 同 `actor.get_info`

- **示例 1：默认查询（常用核心属性）**
```json
{
  "ver": "2.0",
  "method": "actor.inspect",
  "params": {
    "targets": { "names": ["MyCube"] }
  }
}
```

- **示例 2：定向查询（只看灯光关键参数）**
```json
{
  "ver": "2.0",
  "method": "actor.inspect",
  "params": {
    "targets": { "names": ["PointLight_1"] },
    "properties": ["Intensity", "LightColor", "AttenuationRadius"]
  }
}
```

- **示例响应**
```json
{
  "code": 200,
  "result": {
    "count": 1,
    "actors": [
      {
        "name": "PointLight_1",
        "class": "PointLight",
        "path": "/Game/Maps/Level1.PointLight_1",
        "props": {
          "Intensity": 5000.0,
          "LightColor": { "r": 255, "g": 255, "b": 255, "a": 255 },
          "AttenuationRadius": 1000.0
        }
      }
    ]
  }
}
```

---

## actor.set_property v1.0（通用属性修改 / 带智能提示）

- **Method**：`actor.set_property`
- **Params**：
  - `targets`: 统一 Selector（names/paths/filter）
  - `properties`: 对象，键为属性名，值为目标值。示例：`{"Intensity": 10000.0, "LightColor": {"r": 255, "g": 0, "b": 0}}`
- **行为与防呆**：
  - 自动 Actor → RootComponent → 其他组件 递归查找属性（避免点光源/网格属性找不到）
  - **特殊属性拦截白名单**（调用专用函数，而非简单反射修改）：
    - `ActorLabel` / `Label`：调用 `SetActorLabel()`，自动处理名称冲突（若重名则自动加后缀）
    - `FolderPath`：调用 `SetFolderPath()`，正确刷新世界大纲文件夹归类
    - `SimulatePhysics` / `bSimulatePhysics`：调用 `SetSimulatePhysics()`，触发物理状态重建
    - `Mobility`：调用 `SetMobility()`，正确处理光照/导航网格失效。值可为 `"Static"` / `"Stationary"` / `"Movable"`
    - `Hidden` / `bHidden` / `HiddenInGame`：调用 `SetActorHiddenInGame()`，**运行时隐藏**（编辑器视图中仍可见）
    - `HiddenInEditor` / `bHiddenInEditor` / `bHiddenEd`：调用 `SetIsTemporarilyHiddenInEditor()`，**编辑器隐藏**（在编辑器视图中立即隐藏/显示）
    - `Tags`：Actor 标签数组，支持三种模式：
      - 数组覆盖：`["tag1", "tag2"]` 替换所有标签
      - 单字符串：`"tag1"` 添加单个标签（不覆盖）
      - 增删对象：`{ "add": ["tag1"], "remove": ["tag2"] }` 精确控制增删
  - 属性不存在：不会直接 404，会返回 `suggestions`（按编辑距离排序），提示可能的正确属性名
  - 类型不匹配：返回 `expected_type` 及 `current_value`，帮助 AI 校正格式/类型
  - 支持类型：数字（整型/浮点）、bool、string/name/text、FVector、FRotator、FLinearColor、FColor；其它结构会提示不支持
- **Response**：
  - `count`: 成功修改的 Actor 数量
  - `actors`: 数组
    - `name`, `class`, `path`
    - `updated`: 成功写入的键值
    - `errors`: 可选数组，包含 `{ property, error, suggestions?, expected_type?, current_value? }`；对于 ActorLabel 名称冲突场景，会返回 `{ property, warning, requested, actual }`

- **示例**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["PointLight_1"] },
    "properties": {
      "Intensity": 10000.0,
      "LightColor": { "r": 255, "g": 0, "b": 0 }
    }
  }
}
```
```json
{
  "code": 200,
  "result": {
    "count": 1,
    "actors": [
      {
        "name": "PointLight_1",
        "class": "PointLight",
        "updated": {
          "Intensity": 10000.0,
          "LightColor": { "r": 255, "g": 0, "b": 0, "a": 1 }
        }
      }
    ]
  }
}
```

- **示例 2：重命名 Actor（修改 ActorLabel）**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["Floor"] },
    "properties": {
      "ActorLabel": "MainFloor"
    }
  }
}
```
```json
{
  "code": 200,
  "result": {
    "count": 1,
    "actors": [
      {
        "name": "MainFloor",
        "class": "StaticMeshActor",
        "updated": {
          "ActorLabel": "MainFloor"
        }
      }
    ]
  }
}
```

- **示例 3：归类到大纲文件夹（FolderPath）**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "filter": { "class": "SpotLight" } },
    "properties": {
      "FolderPath": "Lighting/SpotLights"
    }
  }
}
```

- **示例 4：开启物理模拟（SimulatePhysics）**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["Cup_01"] },
    "properties": {
      "SimulatePhysics": true,
      "Mobility": "Movable"
    }
  }
}
```

- **示例 5：隐藏 Actor - 运行时隐藏（bHidden）**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["DebugHelper"] },
    "properties": {
      "bHidden": true
    }
  }
}
```

- **示例 6：隐藏 Actor - 编辑器隐藏（HiddenInEditor）**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["ConstructionGuide"] },
    "properties": {
      "HiddenInEditor": true
    }
  }
}
```

- **示例 7：添加标签 - 单个标签**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "filter": { "name_pattern": "test_*" } },
    "properties": {
      "Tags": "test"
    }
  }
}
```

- **示例 8：设置标签 - 覆盖所有标签**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["Player_Start"] },
    "properties": {
      "Tags": ["PlayerSpawn", "Important", "DoNotDelete"]
    }
  }
}
```

- **示例 9：增删标签 - 精确控制**
```json
{
  "method": "actor.set_property",
  "params": {
    "targets": { "names": ["OldActor"] },
    "properties": {
      "Tags": { "add": ["NewTag"], "remove": ["DeprecatedTag"] }
    }
  }
}
```

---

## actor.destroy v2.0 （统一 Selector）

- **Method**：`actor.destroy`
- **Params**：
  - `targets`: 对象（与 `actor.set_transform` 选择器一致）
    - `names`: 可选，字符串数组，按 Label 匹配
    - `paths`: 可选，字符串数组，按对象路径匹配
    - `filter`: 可选，对场景扫描筛选
      - `class`: 类名包含匹配（模糊，忽略大小写）
      - `name_pattern`: 名称通配匹配（Wildcard）
      - `exclude_classes`: 数组，排除类名（全等匹配，忽略大小写）
  - 兼容：旧字段 `name/path` 会被自动转换。（`actor.destroy_batch` 已于 2026-09-16 删除，批量删除直接用 `targets.names/paths`。）
- **Response**：
  - `count`: 成功删除的数量
  - `target_count`: 被选中的数量
  - `deleted_actors`: 数组，包含已删除的 `name/path/class`
- **示例**：
```json
{
  "method": "actor.destroy",
  "params": {
    "targets": {
      "names": ["Cube_1", "Sphere_Test_3"]
    }
  }
}
```
```json
{
  "code": 200,
  "result": {
    "count": 2,
    "deleted_actors": ["Cube_1", "Sphere_Test_3"]
  }
}
```
```json
{
  "method": "actor.destroy",
  "params": {
    "targets": {
      "filter": {
        "class": "DecalActor",
        "name_pattern": "*_Debug_*"
      }
    }
  }
}
```

 

##  actor.set_transform （统一变换接口）
  - 结  构：`targets`（选择器） + `operation`（操作）
  - `targets` 字段：
    - `names`: 字符串数组，指定 Actor 名称。
    - `paths`: 字符串数组，指定 Actor 路径。
    - `filter`: 筛选器对象，支持 `class` (包含匹配), `name_pattern` (通配符), `exclude_classes` (排除类名数组)。
  - `operation` 字段：
    - `space`: `"World"` (默认) 或 `"Local"`。
    - `snap_to_floor`: `true` (执行贴地)。
    - `set`: 绝对值设置 (`location`, `rotation`, `scale`)。
    - `add`: 增量设置 (`location`, `rotation`, `scale`)，支持负数。
    - `multiply`: 倍乘设置 (`location`, `rotation`, `scale`)。
    - 计算顺序：先应用 `set`，再 `add`，最后 `multiply`；若 `space = "Local"`，增量位移会按本次最终旋转（累积后的 `rotation`）进行方向变换。
  - 示例 1：单体绝对设置（Z=200）
    ```json
    {
      "ver":"1.0","type":"req","id":"t1","method":"actor.set_transform",
      "params":{
        "targets": {"names": ["MyCube"]},
        "operation": {
          "set": {"location": {"z": 200}}
        }
      }
    }
    ```
  - 示例 2：批量增量（所有灯光 Z 轴上移 500，局部坐标系）
    ```json
    {
      "ver":"1.0","type":"req","id":"t2","method":"actor.set_transform",
      "params":{
        "targets": {
          "filter": {"class": "Light"}
        },
        "operation": {
          "space": "Local",
          "add": {"location": {"z": 500}}
        }
      }
    }
    ```
  - 示例 3：多选倍乘（Cube_1 和 Sphere_2 放大 2 倍）
    ```json
    {
      "ver":"1.0","type":"req","id":"t3","method":"actor.set_transform",
      "params":{
        "targets": {
          "names": ["Cube_1", "Sphere_2"]
        },
        "operation": {
          "multiply": {"scale": {"x": 2, "y": 2, "z": 2}}
        }
      }
    }
    ```
  - 响应（code 200）：
    ```json
    {"ver":"1.0","type":"res","id":"t1","code":200,"result":{"count":1,"actors":[{"name":"MyCube",...}]}}
    ```






