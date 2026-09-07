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
