# AI4Science 实验基础设施 v0.2

## 宿主与范围

本项目基于 [UPSTREAM.json](UPSTREAM.json) 指定的 Harness 提交，并包含可审查的本地宿主补丁。运行模型、创建和恢复 Session、原生父子执行、驻留、冷恢复、inbox 投递和子节点退出仍由 Harness 管理。

首版限定单机、一个受信管理域、每个设备范围一个有效控制者。执行库可以保存多个项目；一个活动 Agent 组织只绑定一个宿主科研项目。未实现通用 Team 引擎、消息服务、工作流编译器、分布式调度或另一套 Agent Runtime。

## 模块与状态归属

| 内容 | 实现和权威记录 |
|---|---|
| 模型执行、Session、Agent inbox | 原生 Harness |
| 角色配置、数量、工具、创建权限、任务关联 | `platform/organization.ts`；运行时只保存必要关联，任务事实写入执行库 |
| 项目、请求、操作、资源、预算、结果元数据 | `platform/execution.ts` 中的 `execution.sqlite` |
| 实验需求、操作关联、决策、评估与结束事实 | `platform/experiments.ts`，与操作共用 `execution.sqlite`；不创建会话或调度器 |
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

一次 run 仍对应一个操作，`runId === id`。v0.2 新增独立 experimentId 关联多次操作；操作身份与 Provider 协议不变，不生成隐藏的 DAG。

资源检查、预算预留和操作登记在同一 SQLite 事务中提交。实际设备动作发生在持久化 dispatch intent 之后，无法随数据库回滚。相同项目中的相同 requestKey 和输入跨重启返回原操作，输入变更被拒绝；换一个 key 是新请求。

启动先获得排他控制权，再加载未完成记录并向匹配版本/配置的 Provider 核对，之后才接受新操作。完成操作不重放。unknown/not_found、丢失回复和配置不兼容保留资源与预算；未知不被当作空闲。配置不兼容还会阻止该 Provider 的新提交，避免改资源名绕过旧占用。

只有观察到 succeeded/failed/cancelled 才释放资源。预算登记时全额保守计费，失败或部分取消也不自动退款。取消请求不等于取消完成；退出 Agent、插件和管理命令不等于设备停止。

Provider 调用超时会记录 unknown，但底层调用可能仍在执行。关闭等待其真正结束，并继续持有控制权。永久挂起的进程须由操作者外部终止，之后重新启动并核对；这不是自动恢复成功。

两个参考适配器在查询时推进本地采样或计算块，没有查询时暂停，重启后从独立日志继续。它们证明的是接口和控制行为，不代表真实硬件安全性。

## 数据与限制

Provider 已发布路径的内容或媒体类型变化会被拒绝，原哈希不会被替换，操作进入 unknown。读取和导出复核哈希；衍生产物递归核对来源访问权限。报告的统计推理正确性不属于基础设施检查。

设备域重新绑定、未知操作强制清除、恶意同进程插件隔离、模型内部思考恢复、分布式高可用、文件系统断电持久性和真实设备适配尚未支持或验证。具体本地验收结果见 [validation/v0.1.json](validation/v0.1.json)。

## 实验需求与反馈闭环

v0.2 的 `engine.experiments` 和 `experiment_*` 工具负责记录目标、领域方法及版本、声明输入产物、输出要求、预算、操作总数和有限的精确动作目录。具体采样条件、完整性判断和 Markdown 报告位于 `scenes/sampling.ts`；核心不理解 initial/followup、科研假设或统计判断。两个角色配置使用相同需求完成不同深度的真实宿主委派，原跨分支通信授权和默认拒绝范围不变。

每次 action 包含稳定 requestKey、actionId、理由、历史 operationId/artifactId。新操作登记、实验关联和用量、项目预算及资源检查共用原 SQLite 事务，然后走既有派发机制。重复决定返回原操作；改变相同 key 的决定被拒绝。只有该实验已确认终态的操作及其完整来源链，或预先声明的输入产物，可以作为证据；要求执行证据的追加动作不能只引用初始输入或另一个实验的记录。

创建时记录各 Provider 描述的版本与 SHA256，描述中的非秘密配置也参与计算。状态返回这些固定指纹；重启后变化会阻止新动作，恢复原配置或建立新实验才可继续。已有完成操作仍可读取。此核对不验证插件二进制或第三方科学方法代码，适配者仍有责任正确更新版本。

实验 controller 是当前引擎签发的真实 OperationContext 对象，创建时获得控制；claim 不得替换另一个仍有效的对象。上下文撤销、Agent 关闭或宿主退出后，新获准执行者必须显式 claim；同 actorId 不继承权限。获准 worker 可以在 controller 有效时提交批准的动作，只有 controller 可以 resolve/finish/cancel。参与者目前须具备需求中所有 Provider 的访问范围；role tools 再约束可做的动作。实验权限在操作登记事务中再次核对；接纳后撤销 controller 会阻止新动作，不撤回或取消已接受操作。这不新增通用 ACL，也不恢复原跨分支父节点授权。

受限 worker 不应同时获得 `execution_submit` 等直接操作工具；否则其原有 Provider 权限仍允许独立操作。SDK 和 CLI 是受信管理入口，不是恶意插件沙箱。CLI 对既有实验的写操作每次都以当前配置的操作者显式 claim 并记录原因；重复动作读取原结果不要求重建旧 controller。

`experiment_wait` 由程序调用原 Provider query，并以持久序号返回变化。只有新状态、进展、详情或产物形成 observed 事件，未变化的轮询不伪装进展。等待超时写入事实并返回 timeout，既不取消操作，也不释放资源；工具被中断或插件关闭只停止观察。unknown 经核对仍无法确认时返回 blocked，不能推进新的实验动作。当前是有界程序轮询，不声称设备主动推送通知或自动重启后的 Agent 续思考。

执行状态区分 running、awaiting_decision、needs_review、blocked、cancelling、cancelled、completed。escalate 保存越界提案并停止新接纳，不声称已停设备；controller 的 resolve 仅允许按原需求继续，修改需求须创建新实验。取消先持久记录请求，再逐项使用现有 cancel；只有全部已接受操作具有确认终态，聚合状态才是 cancelled，成功、失败和部分取消的原记录均保留。unknown 保留占用与预算；全额保守计费不退款。

领域评估是带方法版本、理由和来源引用的数据，不是平台给出的科学真值。通用 finish 要求操作已结束、必需动作已执行、完成产物及其来源可读取；它不认证数据质量或科学结论。采样场景的 sampling_finish 额外检查自己的观测数量要求后生成执行报告。无产物的失败可通过取消/停止管理保留记录，不伪造成功报告。CLI 的 assessor 模块只能由受信操作者显式选择，模型工具不开放任意文件导入。

执行库 schema 从 1 单调迁移到 2，新增实验三张关联表，创建事件复用原 events 表；迁移与版本更新同事务提交。旧 completed 操作、预算、哈希与数据关联保持原值且不重放。旧 v0.1 程序拒绝 schema 2，无降级器。已有操作级控制器锁仍唯一；实验 controller 只是当前管理进程内的动作权限，不替代设备控制锁。

本轮不支持连续步骤之间的资源租约、任意参数重规划或通用实验编译器。需要跨步骤持续持有资源的动作应由单个 Provider 操作完整承接。跨分支仍仅传受约束结果引用和关联回复。新增实验接口没有扩展 dashboard，详情通过 CLI、工具或公开导出读取。实际验收见 [validation/experiments-v0.2.json](validation/experiments-v0.2.json)。

## 独立计算 Provider：不扩展 v0.1 内核

`integrations/ai4science/external-job/` 增加一个可独立安装的固定计算插件。公开 SDK 仍来自原 `platform/sdk.ts` 和测试工具；只增加编译后的 ESM、类型声明和本地 tarball 交付形式。Provider 只导入公开 SDK、Node 内置模块及自身文件，该 Provider 接入不要求修改组织、授权、通信或 Provider 接口；后续 v0.2 实验关联仅升级平台执行库，不改变 Provider 协议。

Provider 在设备侧 SQLite 事务中登记 operationId、随机 jobId、启动票据、不可变输入和产物目录，同时认领原有管理域。只有首次登记者启动固定的外部 supervisor；重复提交只读取原记录。登记后、真正启动前中断也不会自动重派。输入只有有限长度文本和受限迭代数，不提供任意脚本或 shell 接口。

supervisor 独立于 Harness 存活，持有本作业的 SQLite 排他所有权锁，并创建固定计算 worker。worker 自行推进哈希链，通过 IPC 提交进展；supervisor 保存独立的实际启动、检查点和退出记录。`query` 不推进计算。PID 仅是诊断信息，重连客户端不能凭它实施取消；客户端写入持久取消请求，supervisor 只操作自己仍持有的 ChildProcess，观察实际退出后才发布终态、部分结果或成功产物。已经成功的工作不会因稍后的取消被改写。

启动期限内的 accepted 表示设备侧登记已接受，不代表 worker 已经开始。超过启动期限仍无有效所有者，或运行中的 supervisor 失效时，查询返回 unknown。已有占用和预算继续保留。supervisor 的 IPC 连接断开后，worker 会退出；该路径仍保留 unknown，因为不存在一个可信 supervisor 来确认终态。没有 OS 重启续算或 supervisor 崩溃自动恢复。设备日志或产物发布失败也不得伪造成功。

工作进程继承经过限定的系统环境，不接收模型凭据或可配置执行命令。外部插件仍属于受信本地代码；本轮不提供恶意插件沙箱或分布式作业服务。使用的计算算法保持固定，这次验收不评价科研结论。发布说明和本地结果摘要见 `validation/external-job.json`。

## 上游更新接入

当前宿主已接入 DeepSeek Harness `0.1.7-rc.1`，精确提交为 `46a7f68b0922371ce7144b668b90e377d8e799f4`。上游默认分支为 master，绑定为只读 upstream；origin 保持本项目仓库。`UPSTREAM.json` 是当前基线的唯一记录，历史验证 JSON 继续保留原版本。常规更新通过 `platform/upstream.py` 获取差异、准备隔离工作树，完成兼容迁移和验证后再合并主分支，不自动绕过检查。

上游将原 continuation 管理实现拆成协调器和 activation registry。本地结果交换扩展仍由协调器创建，复用 registry 的真实活实例、父子关系、锁、冷恢复和投递。最后的授权预留移到原生同步投递之前；入箱失败时回滚关联记录。默认关闭和单关系默认值不变。

Session 持久读取返回对象中的 events，而非直接事件数组；相关探针已使用实际新接口。宿主卸载前先通过公开 drain 接口结束 continuable 后代，再释放事件投影，避免读取已卸载的 inbox 状态。V2 到 V3 使用上游相邻版本迁移，原文件不覆盖。新增测试验证旧子会话冷恢复后仍没有自动恢复旧科研授权。

执行数据库仍使用原 schema，公开 Provider SDK 协议仍为 1。两个已有操作、六个产物及其预算/哈希在新宿主下读取、导出后保持一致。外部 Provider 的初始化配置读取在并发打开 SQLite 时暴露了短暂锁竞争；`0.1.1` 对该读取使用与后续连接一致的有界 busy timeout，不扩大权限，也不自动重派未知任务。已有未完成任务仍需保留匹配的旧 Provider 版本。

本轮相对 0.1.5-alpha.1 纳入 1,970 个上游提交。上游新增 maxActiveSubagents 容量控制，默认每个连续父子组织范围最多八个活动子 Agent；角色数量配置不覆盖这个限制。跨分支路径仍经原 activation registry，目标冷恢复也必须取得容量，已有驻留目标不占用新槽。容量不足拒绝投递，释放槽后才可继续，不绕过限制。

agent/created 现为宿主等待的串行初始化。扩展继续在最终同步 enqueue 前复核真实发送者、双方父实例与授权；新增异步初始化间隙内撤销授权的回归，确认不会入箱。scienceResultProject/MaxPairs/MaxPending 是扩展启动时固定值；修改需重启扩展并重新授权，运行时设置不能隐式扩大旧关系。上游 maxActiveSubagents/maxDepth 设置继续按宿主机制生效。

新版 Loader 的 entry.update 仅发起重载，插件 Fiber.await 才表示生命周期工作完成并抛出启动错误。相关卸载测试据此等待，不使用固定 sleep。上游现已直接依赖 Schemastery，因此移除原补丁中重复的包依赖和 tsconfig 引用；补丁已按新基线重新生成，校验见 UPSTREAM.json。Session 保持 V3，执行库保持 schema 2，本轮未增加记录格式迁移。

本轮保留社区 README、操作台、实验层与专用 CI；不启用上游发布和仓库管理工作流。确定性验收包括旧 checkout 生成的真实实验/操作记录在新 checkout 读取、重复请求返回原操作、预算及哈希不变、授权不自动恢复；完整结果见 [validation/upstream-0.1.6.json](validation/upstream-0.1.6.json)。未重新开展真实模型科研评测，其他上游产品界面不作为本项目已全面验证的功能。

## 可复制的 Provider 入门包

`example-plugin/provider` 是独立、短同步的数据处理示例，仅依赖公开 SDK 和 Node 内置模块。它不定义新的 Agent 或执行调度层。业务逻辑、输入校验和输出格式集中在带 CUSTOMIZE HERE 标记的位置；独立 SQLite 日志保存稳定操作身份、管理域、实际计算完成次数和发布哈希。

同一操作重复提交只读取原记录。计算或发布中断后，不以重试方式悄悄重新执行；没有确认的结果仍为 unknown。已经发布的结果被修改会使读取完整性检查失败。短同步操作没有可中断 worker，取消接口明确拒绝已结束任务，对未确认任务报告不支持。该示例用于教学和改写，长任务仍使用已有独立 supervisor/worker 适配，而不把两种生命周期混为一谈。

## 本地前端操作台

`platform/dashboard.ts` 提供同一 dsh 管理进程中的本机 HTTP 适配，复用既有 ExecutionEngine、Artifacts 和 management 权限配置；界面文件位于 `platform/dashboard/`，不维护第二套任务状态或持久数据库。控制器在服务存续期间持有原有域锁。

HTTP 只绑定 127.0.0.1，检查 Host/Origin，控制 API 使用每次运行生成的 bearer 凭据。原生文件下载使用单独的 HttpOnly、SameSite=Strict 会话凭据，且只允许 GET 下载路由；它不能调用状态或控制接口。所有操作仍经过配置内的项目和 Provider 范围检查。产物沿用原有来源访问与哈希验证，预览只显示文本，不执行结果中的 HTML。

页面刷新只读取记录。服务端监测器通过现有 query 方法观察 active 操作，未知状态不自动重试，由操作者显式 reconcile。关闭服务先停止监听与监测、等待已进入的处理，再由宿主关闭执行管理；不把页面或服务关闭当作设备取消。此界面尚不提供远程、多用户或不可信插件隔离。
