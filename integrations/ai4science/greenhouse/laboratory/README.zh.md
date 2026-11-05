# 分阶段实验室设备

English | [中文](README.md)

## 范围

`LaboratoryWorld` 在 `laboratory.sqlite` 中保存样品、设备、已接受操作、检测引用和撤销记录。`openLaboratoryProvider` 接入现有执行 Provider 协议。`LaboratoryClock` 通过共享模拟时钟负责逻辑事件推进；调用方提供原生成员就绪判断和事件投递，并在时钟卸载后关闭设备连接。

六设备[场景](fixture.ts)覆盖前处理与检测链路。[联合场景](scenario.ts)定义六个项目、48 份原始样品、20 个设备实例及具有跨项目依赖的 52 项阶段任务。水路模块控制依赖供水的处理；热控设备按声明的电力需求维持样品保存条件。

## 从源码运行

通过标准 `dsh` profile 安装环境。现有 Mission Control 展示实验室、设备、样品、项目和已提交操作视图。该 profile 创建设备及执行记录，不创建 Agent 或模型请求。

```sh
python3 integrations/ai4science/greenhouse/laboratory/install.py --home .ai4science/laboratory-preview/home --directory .ai4science/laboratory-preview/run --seed 1 --port 0
DSH_HOME="$PWD/.ai4science/laboratory-preview/home" pnpm dsh --profile laboratory-environment
```

打开打印的 Mission Control 启动链接。环境模式下，已接受操作、在途物流和变化中的温度驱动逻辑事件。安静期间保持当前模拟步。经过认证的实验室快照端点提供读取；执行提交使用现有科学仪表板。

脚本单 Agent 工作流程可以使用共享安装器安装：

```sh
python3 integrations/ai4science/greenhouse/install-multi.py --environment laboratory --source scripted --mode single-agent --home .ai4science/laboratory-native-script-r4/home --directory .ai4science/laboratory-native-script-r4/run --seed 1 --port 0
python3 integrations/ai4science/greenhouse/run.py --home .ai4science/laboratory-native-script-r4/home --profile laboratory-single-scripted --no-proxy
```

每轮新试验选择新的运行及 profile 目录。安装器拒绝已有设备或 Router 历史。`evaluate.py <runtime> --offline` 核验已停止且完成数据库检查点的运行。脚本联调使用相同物理工具、原生 Agent 生命周期及 Router 完成路径；记录的模型来源为 `scripted`。

## 物理操作

体积采用整数微升。分装和处理要求先将样品送到所选设备。运输预留兼容的目标位置；进入处理阶段时样品移至机器人。取消或目标故障后保留该位置。隔离及过期材料可以转运至隔离位置；处理要求样品可用且未过期。

已接受操作预留设备和输入样品。装载与处理分别提交事件。处理扣除输入体积；成功后创建关联的子样品。取消、过期及设备故障保留此前的扣除。部分体积处理要求同时容纳剩余输入和输出。

方法声明前处理状态、版本、时长、工作温度、校准要求和清洗要求。设定值变化需要经过逻辑时间才能达到；接纳和处理阶段转换都会检查设备实测温度。同一逻辑时刻先处理故障再处理完成。样品在声明的到期时刻仍可使用，并在下一时刻隔离。查询不推进时间，也不展示未来故障。

热漂移、温控及暴露采用逻辑模拟步。温度变化会在累计暴露超过声明的样品容限之前通知；保存失败会隔离样品。处理中的材料在输入体积扣除后仍记录暴露。共享供电故障可以使处理失败，并保留此前效果。水路故障阻止依赖供水的工作；补水在水箱容量内增加水量。耗材订单创建物流记录，库存只在声明的到货事件出现。

`process` 使用主要 `sampleId` 和可选 `additionalSampleIds` 在一个设备周期内处理多份样品。每份输入必须已送达、兼容且属于操作项目。`volumeUl` 表示每份输入体积；所选耗材覆盖整批。设备 `maximumBatchSamples` 和 `batchMultiple` 控制批次大小及配平数量。已接受操作锁定全部输入，阶段效果原子扣除每份样品。输出保留各自样品谱系和独立检测 ID。用水及处理时长按物理周期计算。不可变产物在 `results` 中列出全部检测；主要 `result` 字段继续供单样品读取使用。

## 记录与恢复

操作 ID 绑定项目、命令和 Provider 身份。相同重试返回已有结果。设备数据库绑定一个执行域。场景规则变化要求使用新目录；以相同规则重新打开会保留已接受操作及阶段效果。

成功的 Provider 查询通过现有产物协议导出不可变 `result.json` 文件。校准复核追加撤销记录，并撤回当前匹配的校准。原始检测记录仍可读取。所选耗材在接纳时预留批次库存，在处理开始时扣除；召回会隔离接触该批次的后代样品，并撤销对应检测。

项目交付要求当前方法版本、独立原始样品及有效前置任务。启用 `externalReferences` 的场景要求明确引用前置项目当前交付中的全部检测。原生交付工具要求成员事先核验读取本项目及跨项目引用对应的产物。同项目阶段结果必须来自所引用前置检测实际产生的样品。逻辑方法修订会撤回受影响交付。替代交付追加新的引用，并撤回不再匹配的下游交付。

## 原生成员

`mountLaboratoryAgents` 编排一名协调员及设施、实验、质量三个原生专业成员。单 Agent 模式创建一个根成员，拥有相同的汇总物理工具和项目访问能力，允许无资源冲突的设备操作并行运行。每个活跃实例获得按项目划分的执行权限；外部成员及项目 ID 会被拒绝。现有 Router Board 通过真实原生父节点投递具名工作消息，并记录信箱回执。

领域工具提供分页样品与历史、当前设备方法、物理命令、核验产物读取、逻辑等待及阶段交付。事件等待会返回并确认已接受的未读 Router 消息，使已经投递的通知能够随等待结果被处理。交付要求该成员事先读取经过核验的结果。Router 完成还要求存在有效的物理阶段交付。修订及撤回会重新打开受影响分派；后续阶段证据必须沿用实际前置样品谱系。温度、设施、耗材与项目变化通过原生输入路由给负责成员，投递提交事件后才继续推进逻辑时间。

原生测试覆盖精确身份、成员消息、自分派、核验交付、重新打开及选择性的环境输入。脚本原生单 Agent 通过工具返回及事件等待完成一个物理阶段。共享安装器 `install-multi.py --environment laboratory --source real-model` 创建 `laboratory-single` 或 `laboratory-multi` profile，记录相同模型及压缩策略，并保存实验室与共享运行时源码快照。启动时拒绝已变化的源码快照。显式的实验室 `--source scripted --mode single-agent` profile 使用公开工具返回执行完整场景。长脚本运行采用普通 profile 生命周期，不设置项目运行时限。其 Provider 标记脚本身份，生产模型 token 用量保持为零。原生多 Agent 脚本策略在设施、实验和质量成员之间分派已发布阶段，由协调员控制依赖顺序。该联调策略采用串行阶段分派验证完整共享证据路径。真实模型成员保留独立的并行操作提交能力。

## 验证

`evaluate.py` 独立读取设备状态、执行记录、产物哈希、Router 状态及原生 Session。它检查当前方法、独立原始样品、实际阶段谱系、原生交付前的核验结果读取、信箱输入及库存核算。它按逻辑模拟步推导完成时刻和任务延迟，记录各路由用量，并依据 Session 事件顺序测量物理并行、重复及原生压缩后的任务续接。最新完成的 Router 交付必须到达拥有者的实际响应。只读 `laboratory-report` profile 展示 `compare.py` 生成的不可变报告；正式对照就绪还要求真实模型身份、相同的已记录策略及实际观测的模型直连 Socket。`--offline` 要求宿主停止且数据库完成检查点。评测器测试通过修改私有副本检查产物、谱系及原生读取记录的拒绝。

任务完成率以场景声明的全部任务为分母；实时视图另行标明已发布任务完成率。未完成的试验也可以具有有效证据。材料状态可达性包含处理中或分装中的潜在产物及检测结果。材料损失终态要求：即使采用这一乐观判断，所有剩余任务也均不可能完成；没有运行中的物理操作；全部预定故障、修订和任务发布均已发生。资源短缺或模型决策缓慢本身不会终止试验。

人工介入次数为以 `laboratory-operator` 身份提交的执行操作数量，包含失败的设备动作。重新读取或重试同一已接受操作不会增加介入次数。评估器记录操作 ID，并按设备事件顺序重建第一次介入前的自主交付，分别保留自主和辅助后的完成率。单 Agent 和多 Agent 要求记录相同的人工介入规则；辅助后的证据与自主对照条件通过状态分别报告。执行者记录不可用时，实时视图将人工介入次数标为待核验。

`world.spec.ts` 覆盖物理链路、重启、取消、并发接纳、库位预留、过期和校准复核。`provider.spec.ts` 使用真实 ExecutionEngine 和产物读取器，检查身份及接纳后的拒绝。

`feasibility.spec.ts` 通过真实 ExecutionEngine 完成全部 52 项任务，并保留配置的故障、耗材召回及方法修订。它使用脚本策略验证存在可执行的恢复路径，包括设施维护、补水和耗材订购。

时钟在故障后保留独占归属，卸载时等待在途投递。完整真实模型成对试验、重复场景及最终浏览器证据仍属于实验验证工作。
