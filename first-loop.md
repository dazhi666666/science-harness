# 运行与 first-loop 示例

## 本地操作

在仓库根目录运行 `python3 integrations/ai4science/platform/setup.py`，然后按 [README](README.md#quick-start) 安装管理 profile。部署配置示例为 [local.config.json](integrations/ai4science/platform/examples/local.config.json)，文件路径相对于此 JSON 解析。模型配置不属于执行内核。

每个管理命令取得控制权、核对未完成记录、执行命令并关闭。恢复查询可能推进本地 Provider，因此 status/stop 不是设备的零副作用快照。

```sh
python3 integrations/ai4science/platform/manage.py --home .ai4science/home list --project example
python3 integrations/ai4science/platform/manage.py --home .ai4science/home facts --project example
python3 integrations/ai4science/platform/manage.py --home .ai4science/home reconcile --project example
```

以下 OPERATION_ID、ARTIFACT_ID 是待替换的说明性占位符，使用 start/query 输出的实际值：

```sh
python3 integrations/ai4science/platform/manage.py --home .ai4science/home query --project example --operation OPERATION_ID
python3 integrations/ai4science/platform/manage.py --home .ai4science/home wait --project example --operation OPERATION_ID --timeout-ms 30000
python3 integrations/ai4science/platform/manage.py --home .ai4science/home cancel --project example --operation OPERATION_ID
python3 integrations/ai4science/platform/manage.py --home .ai4science/home export --project example --artifact ARTIFACT_ID --target .ai4science/exported-result.json
python3 integrations/ai4science/platform/manage.py --home .ai4science/home stop --project example
python3 integrations/ai4science/platform/install.py --home .ai4science/home --uninstall
```

取消后查询实际状态；stop 仅关闭管理，不确认设备停止。导出不覆盖现有文件。卸载只删除安装器拥有的 profile，保留项目和 Provider 数据。请保持既有数据库和设备日志的目录关系；复制数据库到另一个目录不构成设备接管。

## 更换组织与执行能力

[fork.json](integrations/ai4science/platform/scenes/fork.json) 与 [chain.json](integrations/ai4science/platform/scenes/chain.json) 给出不同角色和委派结构。部署宿主时显式启用科研结果扩展，并让平台配置中的项目匹配宿主项目。未启用或接口不兼容时会直接失败。

通过场景配置选择 provider/model、工具、角色关系和数量；通过 roleProviders 授予具体执行能力。新的 Provider 只需实现公开 SDK，添加至部署文件中的 providers 数组；[长计算适配器](integrations/ai4science/platform/providers/compute.ts) 就是与仪器不同输入输出的例子。

<a id="experiment-v02"></a>

## v0.2 实验级操作

最短的可复现入口仍是宿主 dsh profile，不需要模型凭据。以下命令创建独立测试目录、安装 profile 与公开接口接入的外部 Provider，执行有证据的采样追加、长任务重连和实际取消：

```sh
python3 integrations/ai4science/platform/experiment-check.py --output .ai4science/experiment-demo
```

目录必须是新的。查看 `results.json` 的断言、`commands.json` 中各次真实命令及 stdout/stderr、`assessment.json` 的读数统计。原始数据在 execution 的产物目录，设备 starts/samples 位于 instrument/instrument.sqlite，外部作业的真实启动与退出记录位于 external-device/jobs.sqlite；这些都来自实际执行。脚本退出后 home profile 保留，可继续通过原管理命令查看项目 experiments。公开验证摘要去除个人路径，完整运行记录保留本地，不另生成 ZIP。

手动操作可沿用 Quick Start 的 profile 和项目 example。先创建需求，再使用返回的真实实验 ID：

```sh
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-create --project example --key sampling-1 --input integrations/ai4science/platform/examples/sampling.request.json
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-list --project example
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-status --project example --experiment EXPERIMENT_ID
```

创建只记录需求，不派发设备动作。EXPERIMENT_ID 等大写值是待替换占位符，不能原样执行。将下面 JSON 保存为初次决定文件，例如 `.ai4science/measure.json`：

```json
{"requestKey":"measure-1","actionId":"measure","rationale":"Collect the approved initial observations."}
```

```sh
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-act --project example --experiment EXPERIMENT_ID --input .ai4science/measure.json
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-wait --project example --experiment EXPERIMENT_ID --until decision --timeout-ms 30000
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-assess --project example --experiment EXPERIMENT_ID --assessor integrations/ai4science/platform/scenes/sampling.ts
```

评估器实际读取 raw.json：初次应看到 observed=4、required=6 和 insufficient。将返回的 artifactId 填入下一份决定，不猜测结果 ID：

```json
{"requestKey":"supplement-1","actionId":"supplement","rationale":"The recorded completeness assessment found four observations below the required six.","evidenceArtifactIds":["ASSESSMENT_ARTIFACT_ID"]}
```

保存为 `.ai4science/supplement.json`，用相同 experiment-act/experiment-wait/experiment-assess 命令完成追加和复核；此时 observed=6。完整检查脚本实际执行这些命令并验证独立设备记录。`--assessor` 选择的是可信本地领域模块，通用入口不导入固定的采样方法；不要将任意模型文本当作模块路径。新增方法可以实现相同 `assessExperiment(engine, context, experimentId)` 导出。

结束决定 JSON 由 summary、artifactIds 和 assessmentIds 组成，使用已返回的真实标识。通用结束只核对执行已结束和来源完整；采样场景的 Agent 工具 sampling_finish 还会执行自己的完整性检查并生成 Markdown 执行报告。

```sh
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-finish --project example --experiment EXPERIMENT_ID --input COMPLETION_JSON
python3 integrations/ai4science/platform/manage.py --home .ai4science/home export --project example --artifact ARTIFACT_ID --target .ai4science/experiment-result.json
python3 integrations/ai4science/platform/manage.py --home .ai4science/home experiment-cancel --project example --experiment EXPERIMENT_ID
```

需要越界调整时使用 `experiment-escalate --reason TEXT --input PROPOSAL_JSON`，阻止新动作并保留提案。当前 controller 用 `experiment-resolve --reason TEXT` 只能继续原需求；更改参数或方法要建新实验。状态中的 lastIssue 显示最近一次登记失败；budgetUsed 与 projectBudget 分别是实验和项目的保守用量。providerBindings 显示创建时固定的版本/配置指纹，变化会阻断追加动作。

每条 CLI 写命令在新进程中以当前获准操作者显式 claim，读取历史 actorId 不恢复权限。普通 Agent 通过 role tools 获得有限能力，受限 worker 不授予绕过实验动作目录的 execution_submit。跨分支通信仍要求双方真实父节点授权，实验接管不替代此步骤。等待超时或停止管理不等于设备取消；必须继续查看实际状态，unknown 保留占用及预算。

两个确定性组织使用相同 `sampling.request.json`，配置分别在 `examples/sampling.compact.organization.json`（controller → worker）和 `examples/sampling.hierarchical.organization.json`（controller → manager → worker）。测试通过真实 Harness 创建、身份传递、等待、消息续跑和退出；数据质量不足的分支由实际工具返回驱动。模型标识 teams-probe/script 仅供测试组合，生产模型由宿主配置另行提供。测试保留的报告和 Session 记录位于被 Git 忽略的 `integrations/ai4science/evidence/platform/organization/experiment-*`，不能误称为本轮真实模型验收。

```sh
pnpm exec vitest run --config integrations/ai4science/platform/vitest.config.ts integrations/ai4science/platform/experiment-organizations.spec.ts --reporter=verbose
```

打开旧执行库会事务性迁移 schema 1 → 2；已完成操作不重放，数据库和 Provider 目录不能随意更换。旧版本程序不支持 schema 2，未提供降级迁移。当前页面仍展示原操作级功能，实验详情通过 CLI/工具/SDK 读取。本轮结果见 [validation/experiments-v0.2.json](validation/experiments-v0.2.json)，不重新评估科研结论，也不新增设计文档。

## First-loop 是场景应用

研究问题仍是比较条件 -1 与 +1 下的模拟仪器输出，同时考虑采样顺序漂移和不确定性。其五个角色及真实父子关系为：主 Agent → 研究 A → 中脑 A，以及主 Agent → 研究 B → 中脑 B。

[场景插件](integrations/ai4science/platform/scenes/first-loop.ts) 组合平台并保留初始实验、证据分析、追加实验决策与报告规则。[角色配置](integrations/ai4science/platform/scenes/first-loop.json) 保留 A/B 分工和模型选择，核心不规定这些角色或阶段。分析函数从原示例复用，不变成平台规则。

[确定性迁移测试](integrations/ai4science/platform/scenes/first-loop.spec.ts) 在新执行库上执行两次初始运行和一次决策关联追加运行，校验来源和报告引用；测试载荷明确是脚本，不是模型科研结论。宿主与 Provider 的实际组合、授权、结果读取和回复另由 [plugin.spec.ts](integrations/ai4science/platform/plugin.spec.ts) 验证。

迁移后场景的真实模型启动**尚未运行**。可选 [first-loop.patch.yml](integrations/ai4science/platform/scenes/first-loop.patch.yml) 需要 AI4S_PLATFORM_CONFIG 和 AI4S_ORGANIZATION_CONFIG 两个绝对配置路径，并在部署中允许 first-loop-v01 项目。模型连接沿用已有 Harness model patch；凭据仅由环境或外部凭据文件提供。不要把密钥、主机个人配置或运行数据提交进仓库。

原 [first-loop 实现](integrations/ai4science/first-loop/plugin.ts) 保留为历史示例。其一次真实模型运行曾完整接通五 Agent、仪器、通信、追加实验和报告；完整数据及原报告审阅留在 v0.1 交付 ZIP 中。当前社区源码准备不重新评估模型的科研能力，也不把历史脚本伪装成新的真实模型验收。

## 验收记录

```sh
python3 integrations/ai4science/platform/check.py --output .ai4science/check-01
```

此命令运行 36 项基础设施测试及 237 项保留回归，并启动真实 CLI 完成 29 条命令和 25 项断言。CLI 输出包括 Provider 独立动作日志，以确认去重没有仅停留在平台日志。新增代码或条件不同可能改变测试数量，应以实际输出为准。

原版本的本地安装、独立解压、类型检查、273 项测试和 CLI 检查均已通过，摘要见 [validation/v0.1.json](validation/v0.1.json)。本次整理后的执行结果单独记在 [validation/community.json](validation/community.json)，不混淆旧证据与新验证。GitHub 托管 CI 尚未运行。完整故障矩阵、真实硬件和多操作系统验收不作为当前已通过的事实。

<a id="external-local-job"></a>

## 独立计算插件

按 [README 的独立执行步骤](README.md#independently-running-execution-plugin) 构建并安装两个本地包，生成的 `config.json` 指向安装目录中的 Provider。安装器核对 tarball 哈希，离线安装，禁用 npm 安装脚本；不复制插件源码进平台目录。SDK 与 Provider 尚未发布至公共包注册表。

参数为 `text` 和 `iterations`；安装器生成一个 2,000,000 次迭代的示例。每次迭代消耗一个预算单位。`chunkSize` 决定每次上报的计算量，`pollMs` 决定 supervisor 检查取消请求的间隔，`startupTimeoutMs` 决定没有确认启动时等待多久后报告未知。计算不靠这些查询或取消轮询推进。

提交命令退出后，已接受的任务继续运行。使用原命令入口和返回的实际 ID 操作：

```sh
python3 integrations/ai4science/platform/manage.py --home .ai4science/local-job-home query --project external --operation OPERATION_ID
python3 integrations/ai4science/platform/manage.py --home .ai4science/local-job-home cancel --project external --operation OPERATION_ID
python3 integrations/ai4science/platform/manage.py --home .ai4science/local-job-home wait --project external --operation OPERATION_ID --timeout-ms 30000
python3 integrations/ai4science/platform/manage.py --home .ai4science/local-job-home export --project external --artifact ARTIFACT_ID --target .ai4science/external-result.json
```

这些大写 ID 是占位符，替换为实际输出。query 返回 progress 中的稳定 jobId、迭代数、取消标记和已观察到的退出码/信号。结果包括 `digest.json`、`execution.json`、`execution.log`；设备侧 `jobs.sqlite` 独立记录真实 worker 启动和检查点。`progress.diagnosticLog` 指向设备目录中的启动诊断日志，程序缺失等问题会保留在其中。

首次启动有界等待后仍无法确认、监督进程死亡或查询失败时，平台保留 unknown 与占用；不能通过重新提交同一 key 启动另一份任务。取消请求不等于终止确认。永久未知情况需要人工核对，不提供强制成功或自动清空资源入口。普通 Harness 关闭不取消外部工作，但操作系统重启、supervisor 崩溃后的续算及真实设备尚未支持或验证。

`external-job/check.py` 在源码目录外安装两个包，使用独立 Python 实现复算哈希结果；在没有 Provider 查询的间隔检查设备进度；验证宿主 SIGKILL 后的原操作找回、丢失回复、并发重复提交、无关项目及失效上下文、监督进程死亡、可执行文件缺失和实际取消。脚本 Agent 还会通过原平台工具完成提交、等待、读取与结束。完整日志保存到指定输出目录，不提交个人路径和设备数据库到公共源码仓库。

## 更新宿主后的使用

当前宿主基线见 [UPSTREAM.json](UPSTREAM.json)。运行 `python3 integrations/ai4science/platform/upstream.py check` 可获取上游 master 的差异；有更新时可用 prepare 和一个新目录建立隔离集成工作树。版本升级后先重新运行 `platform/setup.py`，构建新的 native system addon，再执行平台与外部插件验收。

仓库内示例跟随当前版本；已经生成到仓库外的部署 JSON 不会被自动改写。将其中 baseline 显式改为新提交后，保留原设备目录、原任务身份和未完成操作所要求的 Provider 版本，再通过原 CLI 核对已有记录。不要将重启解释为重新授权，也不要因版本不匹配而清空占用。

旧 first-loop 验证器仍认可已验收的原始基线/补丁组合，并会优先选择每个会话目录的最高 JSONL 版本。新运行的版本与补丁信息来自当前 UPSTREAM.json。升级后没有重新开展真实模型科研过程；当前证据包括确定性 Agent 集成、V2 子会话迁移、已有执行记录读取、独立计算插件和上游相关回归。

2026-09-18 接入的上游为 0.1.6-alpha.2（ddefc45fbc7f8e46dd73185e68295696d1297887）。升级后使用原 setup/install/manage 命令；外部部署 JSON 中的 baseline 必须显式更新，旧 pin 会被拒绝。保留执行库、设备目录和 Provider 配置；Session V3 与 execution schema 2 均不变。旧记录可查且重复请求不重放，不自动恢复任何旧 Agent 或实验 controller 授权。

宿主 maxActiveSubagents 默认八个活动子 Agent，计入连续父子关系下的后代；组织角色上限与此独立。大组织需配置两者，容量不足时冷恢复消息会被拒绝，不能解释为已接受或已处理。插件配置更新后用宿主 Fiber.await 确认重载完成。相关回归与实际命令见 [本轮记录](validation/upstream-0.1.6.json)。

## 通用插件入门示例

新增 `integrations/ai4science/example-plugin/provider/` 作为可复制的入门包。`workload.mjs` 提供与具体学科无关的线性数据转换和输入校验；`index.mjs` 展示公开 Provider 接口、描述、资源与预算、稳定身份、独立持久记录和产物发布。`CUSTOMIZE HERE` 标出需要替换的部分，包内自带 Node 测试，不依赖平台测试私有接口。

安装步骤见 [README](README.md#copyable-provider-example)。构建器复用现有 SDK 打包入口；生成两个可离线安装的包和配置示例。配置经原有注册路径加载，真实 CLI 可以提交、查询、取消和导出，不需要修改科研组织或核心代码。

示例输入为 values、scale、offset。`[1,2,3]` 经 scale=2、offset=1 得到 `[3,5,7]`，同时保存 JSON、CSV 和 count/min/max/mean。预算按输入元素数计费。工作量限制为 10000 个数，属于短同步计算，不支持执行中断；取消接口明确返回 rejected 或 unsupported。未确认发布的操作保留 unknown，不自动重算。数据和状态完整性检查不能替代真实设备的取消、安全与恢复验证。

复制后应同时调整输入 Schema、工作函数、结果格式、能力描述和对应测试。行为变化应更新 package.json 与 PROVIDER_VERSION，并明确新旧执行记录的兼容方式。不要仅更换函数而继续承诺原来的取消或恢复语义。现有独立执行示例仍用于长任务和真实进程退出验证。

## 本地前端页面

已有 management profile 可通过 `python3 integrations/ai4science/platform/manage.py --home .ai4science/home serve --port 8787` 打开操作台。使用终端输出的本次启动链接进入，不分享其中的访问凭据。重启服务后需要新链接，旧凭据失效。页面支持项目切换、创建配置允许的项目、提交 JSON 输入、查看运行详情、请求取消、核对状态和预览/下载结果。

示例页面可先运行 `platform/dashboard-demo.py --directory .ai4science/dashboard-demo`，再以该目录的 home 启动 serve。演示数据由模拟仪器和计算 Provider 实际执行生成，保留原始数据和取消结果；不是伪造生产指标。浏览器关闭不会停止服务，Ctrl+C 才停止本次管理，且不会因此取消独立外部任务。

服务运行时占用同一执行域的控制锁，另一个 CLI 不能同时接管该域。未知操作仍保留资源和预算；页面没有强制成功或清空占用按钮。预览和下载上限为 16 MiB，大结果应在停止操作台后用原 CLI 导出。前端不评估科研结论，也不增加 Agent Runtime、消息服务或工作流引擎。
