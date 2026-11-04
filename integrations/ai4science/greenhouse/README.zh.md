# 火星温室环境

[English](README.md) | 中文

## 范围

运行三个模拟种植舱，共享供电、供水、采样机器人、检测设备与计算服务。环境 profile 不创建 Agent，也不调用模型。它是单 Agent 与多 Agent 对照实验的环境基础，不能作为架构优势的证据。不评估植物生理模型或科研结论。

## 从源码运行

先准备仓库依赖与原生插件，参见[源码安装](../../../README.zh.md)。在仓库根目录执行：

```sh
python3 integrations/ai4science/greenhouse/install.py --home .ai4science/greenhouse-demo/home --directory .ai4science/greenhouse-demo/runtime --port 0
DSH_HOME="$PWD/.ai4science/greenhouse-demo/home" pnpm dsh --profile greenhouse-environment
```

打开打印的 Mission Control 启动链接，令牌仅供本机使用。现有前端增加温室视图；实验运行、Provider 与产物视图使用同一个引擎和设备记录。温室视图明确标识环境演示模式，不创建另一份前端数据库。

通过现有“新建实验”表单提交模拟巡检：Provider 选择 `greenhouse`，请求键填写唯一值，如 `inspect-B-1`，输入为 `{"action":"inspect","chamber":"B"}`。操作完成后导出 `result.json`，现有产物预览会校验并展示它。这是操作者动作，不是 Agent 动作。

Ctrl+C 停止当前宿主的时钟和监听器，不删除状态。重新启动相同 profile 后，从持久逻辑时刻和已接受操作继续；停机期间不模拟时间流逝。对照实验使用独立运行目录。已有状态遇到场景配置变化会拒绝打开，不在不同规则下静默续跑。

## 模拟与操作

[scenario.json](scenario.json) 定义初始数值、操作耗时、变化系数、任务要求和预设扰动。内置演示每一秒推进一个模拟分钟。分钟对分钟的真实时长实验应另存场景，将 `tickMs` 改为 60000，并使用全新运行目录。时钟独立于查询推进，每个设备目录只有一个时钟拥有者。不设置总 token、请求次数或运行时长上限。

操作包括 `light`、`temperature`、`water`、`inspect`、`calibrate`、`sample`、`assay` 和 `analyze`；JSON 字段由 [schema.ts](schema.ts) 定义。它们使用公开 Provider 协议；模拟操作的金额预算计费为零，但记录实际动作和资源使用。水量与电力是场景资源，不是模型消耗上限。本基础版本尚无补水动作。

采样要求任务已出现、种植舱匹配，并满足声明的光照或灌溉条件。必需灌溉须在该任务可用后完成，上一批次的准备不能满足新批次。检测要求真实已完成的样品。分析检查独立样品、采样间隔及跨任务参考，再保存数值摘要，不评估生物学结论。同一样品的重复检测不能冒充多个独立观测。

内置场景在模拟步 20、30、40 分别降低供电、偏移 B 舱水分传感器、加入 C 舱新任务，并在模拟步 80 恢复供电。这些是评估器侧的场景定义，Agent 与前端观察不包含未来扰动及传感器偏移真值。巡检与检测提供独立观察。负载超出供电时实际光照按比例下降，界面同时展示设定值与实际值。

## 记录与生命周期

设备侧 `greenhouse.sqlite` 保存环境、操作、样品、检测与事件。这是 Provider 自己的设备日志，区别于平台原有的 `execution.sqlite`。读取不推进状态。独立时钟锁防止重复推进；时钟故障会报告，并持有归属直到卸载。

操作 ID 跨重启去重，设备绑定到一个规范化执行域目录。平台接纳后发生的明确无副作用拒绝会结算为失败；不确定的存储或身份错误不会被报告为取消成功。此模拟模型的动作效果在完成时原子生效，因此运行中的操作可以在生效前取消。完成产物不可变，后续读取继续校验。

## 验证与后续接入

```sh
pnpm exec vitest run --config integrations/ai4science/greenhouse/vitest.config.ts
pnpm exec tsc -p integrations/ai4science/greenhouse/tsconfig.json --pretty false
pnpm exec vitest run --config integrations/mission-control/vitest.config.ts
```

测试覆盖独立时钟推进、确定性扰动、接纳、资源冲突、取消、重启去重、跨任务证据与前端认证。真实 `dsh --profile greenhouse-environment` 启动和浏览器提交也验证了入口与当前 Mission Control 界面。这些检查不代表书生模型、Agent 协作或上下文压缩已验证。

下文的原生多 Agent 组织接入领域工具与 Router 任务、信箱交流。单 Agent 入口验证、真实模型压缩证据与成对评分的范围分别在下文说明。两种模式必须共用场景定义和执行能力。不要提交模型凭据。

## 原生多 Agent 协作

多 Agent profile 创建一名原生负责人和三名可续接的种植舱协调员，复用 Agent Router 的 `Board` 管理分派与信箱，Harness 仍是唯一的 Agent 运行时。成员名对应精确的项目 Session ID，新的活跃实例只能通过原生续接登记。跨舱工作消息由收件人的真实原生父节点转交，信封和执行事实保留原始发送者。这条应用信箱不改变原生跨分支结果授权协议。项目外收件人和失效 Agent 对象会被拒绝。

结构化 `greenhouse_*` 工具暴露八种设备动作、观察、校验结果、取消和事件等待。`greenhouse_history` 在上下文压缩后按任务或种植舱分页查回操作 ID，Agent 随后读取已有且经过核验的输出，无需重复设备工作。种植舱协调员执行舱内动作；多 Agent 负责人只获得协调、观察、历史、结果读取与取消工具，通过消息委派物理工作。单 Agent 根成员保留全部领域动作。两种模式都获得相同的持续值守规则，以及区分 Router 分派 ID 与实验 ID 的明确说明。已知资源竞争由程序观察，并在派发前用相同请求键重试；资源归属未知时阻止新动作。等待还会识别已经完成的目标操作和未读信箱。`after_seq` 使用明确的 `greenhouse_observe.eventCursor`；超过当前设备日志的数值会返回实际游标并拒绝等待，合法等待仍无项目时限。

`lab_assign`、`lab_message`、`lab_inbox`、`lab_status` 和 `lab_complete` 使用真实 Router 任务板。任务完成必须关联该温室任务的真实成功分析。投递接受、显式读取信箱、实验实际完成分别记录。回合已结束的成员可以通过原生冷续接接收新工作。工具交接与回合结束使用已有 Session 持久化检查点；协调消息使用 Session V4 接受的生产者专用来源 `greenhouse-coordination`。

使用新目录启动可复现的脚本联调：

```sh
python3 integrations/ai4science/greenhouse/install-multi.py --home .ai4science/greenhouse-team/home --directory .ai4science/greenhouse-team/run-20261103-v4 --source scripted --port 0
DSH_HOME="$PWD/.ai4science/greenhouse-team/home" pnpm dsh --profile greenhouse-multi-scripted
```

该 profile 使用[明确的三任务基线](fixtures/baseline.scenario.json)，关闭预设扰动。脚本适配器读取真实工具结果，将 B 的检测引用交给 C，并显式读取完成通知；生产模型 token 用量记为零。前端明确标识脚本模式，展示真实成员、分派、信箱回执和操作。它不是书生评测，也不能证明长期温室值守、上下文压缩质量或多 Agent 优势。固定基线任务结束后环境仍推进，但脚本成员不自主持续维护水分。

独立核验持久快照：

```sh
python3 integrations/ai4science/greenhouse/verify.py .ai4science/greenhouse-team/run-20261103-v4
```

核验器读取原生 Session 头、设备动作、执行结果、产物哈希、Router 分派与信箱回执。C 成功分析所用的 B 参考，必须在该分析之前通过经过身份核验的 Router 消息或成功的 `greenhouse_result` 读取进入其原生模型输入。两种模式遵循同一规则。`referenceEvidence` 记录实际观测到的通道，`directPeerReferenceBeforeEveryAnalysis` 单独报告直接成员消息的覆盖情况；共享结果读取不代表事前发生过直接私信。任务板消息必须与生产者写入的事实及已接受的原生投递对应。完成通知必须到达负责人的模型。

显式信箱读取回执单独报告；原生输入投递不要求再调用一次 `lab_inbox`。核验器单独报告运行偏离指标，不评分科研论述或架构优越性。必需任务或记录尚未完成时核验可以失败；它不停止运行，也不改写证据。停止宿主后，可对已完成检查点的数据库使用 `--offline`；该显式声明不能用于活跃宿主，非空 WAL 文件会被拒绝。

`install-multi.py --source real-model` 生成书生 profile，保守声明 256000 token 上下文，并配置容量前触发的原生压缩。`--base-url` 选择官方接口，`--api-key-env` 选择主凭据引用，重复的 `--extra-key-env` 参数将其他凭据加入同一请求池。单／多 Agent 都在原生请求准备阶段轮换 Provider 路由，实际路由保存在 Session 请求头中。模型请求、输入／输出 token 和错误按全局及各路由记录，凭据本身不进入这些记录。token 计量包含接口报告的缓存用量与推理输出，但失败请求可能计费而未返回用量。不按额度调度，也不设置消耗上限。原生压缩默认跟随最近的模型路由，因此摘要请求也可以使用凭据池中的路由。

真实模型 profile 同时加载原生 `llm-retry` 执行器与 Provider 重试设置。临时请求失败会重试失败的原生步骤，保留已经完成的工具效果与持久重试事件。Agent 终止性失败会让前端报告需要处理；宿主仍存活不代表实验成功。单请求接口故障检测、输出容量与整轮消耗上限不同。

`--direct-interface` 与 `--direct-address` 一起使用时，为模型源站选择本地源地址与公开 DNS 解析的 IPv4，保留 TLS 主机名验证。拥有 Agent 的插件在创建任何 Agent 之前安装传输设置；独立插件的列表顺序不保证初始化先后。该可选的本地 TUN 代理绕过方式不修改系统设置。公开 DNS 或网络变化后须刷新地址；网卡不可用时启动失败。macOS 上，在模型请求活跃时运行 `audit-network.py <runtime-directory>`：它查找实际持有环境时钟的进程，通过 `nettop` 记录模型 Socket 的真实网卡。配置日志不能独自证明直连；空闲进程的观测只表示证据不足。对照要求两轮传输设置相同，并且都观察到实际直连网卡。

分派尚未交付时，原生 `agent/turn-stopping` 监听器会提供带实际 Router 与实验 ID 的已记录引导消息。两种模式使用同一监听器；负责人还会收到当前已可用但未分派的任务。因此，简短总结或单次模型输出截断不会放弃这些分派。监听器不增加回合、token 或运行时长限制，不覆盖取消操作，并允许当前工作全部完成后结束回合。后续新增需求仍通过现有环境通知和原生续接路径唤醒成员。

## 动态环境反馈

已提交的供电与新增实验事件通知负责人；传感器异常及传感器可见的越界、恢复事件只通知对应种植舱协调员。通知按收件人合并，写入同一个 Router 信箱，并通过原生续接投递。因此已结束回合的成员也能收到新工作，无需模型轮询。设备完成仍走既有操作等待，不重复发送通知。

观察器只有在所选原生投递接受整批事件后才推进游标。投递结果不确定时停止该观察器，保留原设备事件，并在前端报告需要处理的状态；不宣称收件人已处理，也不无限自动重发。卸载先取消并等待在途投递，再关闭成员和存储资源。

越界提醒使用与观察工具相同的传感器读数，包含可能的传感器偏移，不暴露隐藏的真实水分。观察工具同时提供声明的运行范围与灯具功率系数，供明确的资源决策使用。设备日志中的指标继续独立计算真实越界情况。

`dynamic.spec.ts` 使用原生冷续接和真实领域工具，验证供电协调、依据巡检的传感器校准，以及后来 C 舱实验的完成。模型响应来自脚本，不同时宣称完成了最初三项研究任务。固定基线演示适配器仍不具备通用持续值守能力；动态模型策略的效果、长期运行、压缩和单 Agent 对照仍未验证。

## 单 Agent 对照入口

原生团队协作链路建立后，同一个 Agent 插件可以接受 `mode: single-agent`。它只创建负责人，允许在同一 Router 任务板登记自己的任务，并将所有环境通知路由给该成员，不伪造成员间信箱流量。唯一 Agent 可以使用全部种植舱工具、同时提交独立后台操作、等待事件并读取持久结果。多 Agent 模式继续使用独立原生成员与真实工作消息。两种模式共用设备规则、资源及分析证据要求。

使用现有安装器创建全新的单 Agent 脚本运行：

```sh
python3 integrations/ai4science/greenhouse/install-multi.py --home .ai4science/greenhouse-single/home --directory .ai4science/greenhouse-single/run-20261103 --mode single-agent --source scripted --port 0
DSH_HOME="$PWD/.ai4science/greenhouse-single/home" pnpm dsh --profile greenhouse-single-scripted
python3 integrations/ai4science/greenhouse/verify.py .ai4science/greenhouse-single/run-20261103
```

固定单 Agent 脚本完成相同的三项基线任务与 17 次设备操作，直接使用 B 的检测作为 C 的参考证据。脚本顺序执行是测试策略选择；独立能力回归验证了并行提交不同操作。脚本耗时与为零的生产 token 计量不是模型性能对照。前端标识单 Agent 模式；核验器检查一个持久根会话和自有任务，不要求成员间消息。真实模型 profile 使用 `--source real-model`，选择相同书生路由与压缩配置，名称为 `greenhouse-single`。

## 已保存的对照报告

使用已由 `compare.py --output` 写出的不可变 JSON 报告。`install.py --home <home> --report <report.json> --port 0` 安装 `greenhouse-report`，再用 `run.py --home <home> --profile greenhouse-report` 启动。该入口使用现有 Mission Control 界面，无需模型凭据，也不创建 Agent、执行数据库或环境时钟。它在启动时加载一份报告，保留来源标识和已记录的压缩阈值，并将参考输入通道与直接成员消息分开显示。报告缺失或格式错误会在启动时失败。未完成的已保存对照仍标为未完成；查看报告不代表确立架构优势。选择其他已保存文件前，先停止报告 profile。

模式标识或成功的连通性检查，不能证明单／多 Agent 的实际效果、自然达到 256K 后的压缩或持续值守。使用[实验规程](experiments/README.zh.md)生成更长任务并比较独立核验的记录。安装器为每个全新运行保存源文件内容、哈希及实际模型／压缩设置。 安装后源码发生变化会在创建设备状态之前拒绝启动；重新安装尚未使用的 profile，记录新的输入。`--comparison-file` 在温室页面展示保存的评测配对，但不提供给 Agent；文件缺失表示等待报告，格式错误会让快照请求显式失败。两种模式都不增加总 token、请求次数或运行时长上限。

`run.py` 只启动已安装的温室 `dsh` profile。提供 `--home`、`--profile`，并可通过 `--credentials-file` 指定使用普通 `NAME=value` 行的文件；值只复制到子进程环境，不做 shell 求值，也不打印。`--no-proxy` 只清理该进程的代理环境变量；profile 中的物理网卡直连配置负责绕过 TUN 代理。启动器不设置项目截止时间。
