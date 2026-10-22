# UnrealAgentLink 工具能力（增量）

## 服务端请求：Actor Management

 
- 统一变换接口 `actor.set_transform`
  - 结构：`targets`（选择器） + `operation`（操作）
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






