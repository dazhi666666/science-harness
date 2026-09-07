# AI4Science 基础设施 v0.1

## 宿主与范围

本项目基于 [UPSTREAM.json](UPSTREAM.json) 指定的 Harness 提交，并包含可审查的本地宿主补丁。运行模型、创建和恢复 Session、原生父子执行、驻留、冷恢复、inbox 投递和子节点退出仍由 Harness 管理。

首版限定单机、一个受信管理域、每个设备范围一个有效控制者。执行库可以保存多个项目；一个活动 Agent 组织只绑定一个宿主科研项目。未实现通用 Team 引擎、消息服务、工作流编译器、分布式调度或另一套 Agent Runtime。

## 模块与状态归属

| 内容 | 实现和权威记录 |
|---|---|
| 模型执行、Session、Agent inbox | 原生 Harness |
| 角色配置、数量、工具、创建权限、任务关联 | `platform/organization.ts`；运行时只保存必要关联，任务事实写入执行库 |
| 项目、请求、操作、资源、预算、结果元数据 | `platform/execution.ts` 中的 `execution.sqlite` |
| 单控制者互斥 | 独立 `controller.sqlite` 上的长期 SQLite 排他事务；不是第二套执行事实库 |
| 实际设备动作与检查点 | Provider 自己的持久日志；验收独立检查实际 starts、samples 或 chunks |
| 产物及来源 | `platform/artifacts.ts`；文件完整写入后，将大小、SHA256 和来源提交到执行库 |
| 科研问题、阶段、分析和报告 | 场景插件；first-loop 位于 `platform/scenes/` |

上述平台路径都相对于 `integrations/ai4science/`。

## 组织与通信

角色配置声明可用角色而非完整预建的 Agent 树。`org_create` 检查调用者真实实例、角色数量、父节点创建权限和深度，再调用宿主 `startContinuable`。`org_discover` 返回直接关联和配置允许的协作候选，发现不等于授权。

跨分支通信复用原扩展。`scienceResultMaxPairs` 默认为 1，可显式配置多个精确对象关系；双方真实父节点都必须独立同意。消息仍只包含持久结果引用或关联回复，不开放广播或任意指令转发。原始发送者和真实 `parentSession` 均保留。

宿主在最后同步入箱前复核授权；撤销发生在接受前会拒绝消息，接受后不会召回已入箱消息。接收、开始处理和完成处理是不同事实，接收者读取结果并关联回复才构成应用层处理回执。

旧 Agent 对象不能凭相同 Session ID 获权。父实例替换、失效或组织关闭会使相关授权无效。恢复数据库只恢复事实，不恢复旧授权。新参与者经过真实宿主创建和当前权限校验后，可读取获准任务与执行事实。

`org_wait` 使用宿主事件等待和有界超时；`execution_wait` 由程序查询 Provider。关闭组织通过宿主 drain 结束后代，不声称设备已经停止。原父子接口和 Team 授权在默认模式下保持原行为。

## Provider 公共接口

[SDK](integrations/ai4science/platform/sdk.ts) 不依赖科研角色或 Harness。动态模块导出 `createProvider(config)`：

| 方法 | 语义 |
|---|---|
| `describe` | API/版本、非秘密配置标识、输入输出 Schema、单位、约束，以及完成和取消的含义 |
| `prepare` | 无设备副作用；验证输入，返回实际输入、排他资源和预算预留 |
| `submit` | 使用宿主给出的稳定操作 ID；必须在 Provider 侧持久去重 |
| `query` | 报告状态、进展和结果；无法确认时返回 unknown/not_found |
| `cancel` | 报告 requested/unsupported/rejected，另行报告实际观察到的执行状态 |

Provider 将不可变结果写入 `artifactDirectory`。同一管理域的操作目录共享固定父目录。两个参考 Provider 的设备日志在首次实际提交时与规范化的管理域绑定；设备空闲也不能被另一个域接管。未知操作的查询不会占用首次绑定。

配置文件和已安装插件被视为受信代码。描述中的 configuration 必须是非秘密参数或标识，不能包含凭据。角色工具权限和 `roleProviders` 在程序中检查，不依赖模型声明的身份。

## 提交、取消和恢复

v0.1 的一次 run 对应一个操作，`runId === id`；场景可以关联多次运行，但核心没有隐藏的 DAG。

资源检查、预算预留和操作登记在同一 SQLite 事务中提交。实际设备动作发生在持久化 dispatch intent 之后，无法随数据库回滚。相同项目中的相同 requestKey 和输入跨重启返回原操作，输入变更被拒绝；换一个 key 是新请求。

启动先获得排他控制权，再加载未完成记录并向匹配版本/配置的 Provider 核对，之后才接受新操作。完成操作不重放。unknown/not_found、丢失回复和配置不兼容保留资源与预算；未知不被当作空闲。配置不兼容还会阻止该 Provider 的新提交，避免改资源名绕过旧占用。

只有观察到 succeeded/failed/cancelled 才释放资源。预算登记时全额保守计费，失败或部分取消也不自动退款。取消请求不等于取消完成；退出 Agent、插件和管理命令不等于设备停止。

Provider 调用超时会记录 unknown，但底层调用可能仍在执行。关闭等待其真正结束，并继续持有控制权。永久挂起的进程须由操作者外部终止，之后重新启动并核对；这不是自动恢复成功。

两个参考适配器在查询时推进本地采样或计算块，没有查询时暂停，重启后从独立日志继续。它们证明的是接口和控制行为，不代表真实硬件安全性。

## 数据与限制

Provider 已发布路径的内容或媒体类型变化会被拒绝，原哈希不会被替换，操作进入 unknown。读取和导出复核哈希；衍生产物递归核对来源访问权限。报告的统计推理正确性不属于基础设施检查。

设备域重新绑定、未知操作强制清除、恶意同进程插件隔离、模型内部思考恢复、分布式高可用、文件系统断电持久性和真实设备适配尚未支持或验证。具体本地验收结果见 [validation/v0.1.json](validation/v0.1.json)。
