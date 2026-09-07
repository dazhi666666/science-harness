# science-harness — Infrastructure v0.1

AI4Science Harness is a small, plugin-oriented foundation for scientific Agent organizations and execution Providers. It keeps Agent lifecycle, sessions, native parent-child execution, residency, messaging, and shutdown in DeepSeek Harness while adding configurable organization policy, durable operation records, resource and budget control, result provenance, cancellation, and restart reconciliation.

The repository is intended for community development. A Provider can implement the public `describe / prepare / submit / query / cancel` interface and register through configuration without changing the execution core. The reference integrations include a simulated instrument and a resumable long-running computation. The original first-loop research scenario remains an example application rather than a platform rule.

This release targets one trusted management domain on one machine. It does not claim physical-device safety, distributed high availability, multi-tenant isolation, model-thought recovery, or scientific correctness of model-authored reports. The upstream Harness baseline and local host changes are recorded in [UPSTREAM.json](UPSTREAM.json). The license for new AI4Science additions is still pending project-owner selection; upstream Harness and third-party components retain their existing licenses.

中文说明如下。

面向科研 Agent 组织和执行插件的单机基础设施，基于 DeepSeek Harness。可替换角色配置、接入不同 Provider，并在进程结束、取消和重启后继续核对执行事实。

**当前是社区源码发布候选。新增 AI4Science 代码的许可证尚未确定，因此暂不声称它已按开源许可证发布。** Harness 和第三方组件保留各自原有许可证。此仓库尚未推送至 GitHub，GitHub Actions 尚未实际执行。

## 快速开始

需要 Node.js 22.19+（本地验证使用 22.23.1）、pnpm 11.19.0、Python 3 和 C++ 编译工具链。当前验收平台为 macOS arm64；其他操作系统尚未验证。

在仓库根目录执行：

```sh
python3 integrations/ai4science/platform/setup.py
python3 integrations/ai4science/platform/install.py --home .ai4science/home --config integrations/ai4science/platform/examples/local.config.json
python3 integrations/ai4science/platform/manage.py --home .ai4science/home create --project example --budget 10000
python3 integrations/ai4science/platform/manage.py --home .ai4science/home describe --project example
python3 integrations/ai4science/platform/manage.py --home .ai4science/home start --project example --provider compute --key compute-1 --input integrations/ai4science/platform/examples/compute-input.json --wait
python3 integrations/ai4science/platform/manage.py --home .ai4science/home status --project example
```

安装脚本使用两个现有锁文件安装依赖，编译宿主的 `fs-ext`，并构建类型声明。实际应用入口仍是 `dsh --profile ai4science`，`manage.py` 负责从源码启动它。项目和设备目录均由配置决定；示例运行数据自动被 Git 忽略。

## 能做什么

- 通过配置声明角色、提示词、模型、工具、创建权限、数量和委派深度，运行过程中使用原生 Harness 创建参与者。
- 不同真实父节点下的参与者，在双方父节点独立授权后交换持久结果引用及关联回复；保留原发送者、活实例校验和默认拒绝。
- 一个 SQLite 执行库记录项目、请求身份、资源、预算、状态、结果和任务事实。重复请求跨重启仍返回原操作。
- 两个独立参考 Provider：共享模拟仪器，以及可分块继续的哈希计算作业。设备日志独立记录实际执行，用于检查是否重复动作。
- 程序等待、取消请求、恢复核对、结果完整性检查和导出。原 first-loop 保留为场景应用。

## 开发入口

| 开发目标 | 入口 |
|---|---|
| 接入设备或计算能力 | [公开 SDK](integrations/ai4science/platform/sdk.ts)、[Provider 测试工具](integrations/ai4science/platform/testing.ts) |
| 参考 Provider | [模拟仪器](integrations/ai4science/platform/providers/instrument.ts)、[长计算](integrations/ai4science/platform/providers/compute.ts) |
| 更换组织 | [角色配置与校验](integrations/ai4science/platform/organization.ts)、[示例配置](integrations/ai4science/platform/scenes/) |
| 宿主插件组合 | [platform/plugin.ts](integrations/ai4science/platform/plugin.ts) |
| 持久执行与结果 | [execution.ts](integrations/ai4science/platform/execution.ts)、[artifacts.ts](integrations/ai4science/platform/artifacts.ts) |
| 架构、权限和生命周期 | [architecture.md](architecture.md) |
| 运行命令和 first-loop 示例 | [first-loop.md](first-loop.md) |

Provider 模块导出 `createProvider(config)`，只依赖公开 `sdk.ts`，实现 `describe / prepare / submit / query / cancel`。在部署 JSON 中添加模块路径和参数即可注册，无需编辑核心。Provider 参数和具体研究阶段不属于执行内核。

## 测试与贡献

```sh
python3 integrations/ai4science/platform/check.py --output .ai4science/check-01
```

这个命令不需要模型密钥，运行基础设施、原通信权限、原最小插件、Teams、first-loop 边界及相关上游回归，并通过真实 CLI 做跨进程验收。再次执行请使用新的输出目录。测试结果在指定目录，运行数据不提交到 Git。

v0.1 的原交付通过 36 项基础设施测试和 237 项保留回归（共 273 项），以及 29 条实际 CLI 命令、25 项断言。历史完整证据保留在交付 ZIP；源码仓库只提交[可公开的摘要](validation/v0.1.json)，不复制含本机路径的会话、设备数据库或个人配置。GitHub CI 配置是待运行的自动化，不代表已经通过的远程检查。

提交变更时说明问题、实现和实际执行的检查。Provider 变更需要独立设备执行记录、重复请求、取消和恢复测试；权限变更需要保留负面测试。不要用脚本响应冒充真实模型运行，不用科研结论质量作为基础设施验收门槛。许可证确定后再接受社区代码贡献；目前不添加 CLA 或预设贡献者授权条款。

## 范围与限制

首版为一个受信管理域、单机、每个设备范围一个有效控制者。可保存多个项目，但每个活动 Harness 组织只关联一个项目。参考 Provider 在查询时推进本地工作，没有控制器查询时会暂停。

`unknown` 不释放资源或预算，也不自动重放。预算在登记时全额保守计费，取消后不自动退款。关闭 Agent、插件或 CLI 不等于设备停止。永久挂起的适配器需要外部终止进程，重启后再核对。真实设备、多租户、分布式高可用、模型思考恢复和恶意插件隔离不在本版已验证范围内。

## 上游与许可证

Harness 基线固定为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。宿主已修改；仓库源码已经包含[完整宿主补丁](patches/harness-ai4science-v0.1.patch)，不要重复应用。[UPSTREAM.json](UPSTREAM.json) 记录基线、文件和补丁哈希。

上游 MIT 文本及 DeepSeek 版权声明保留在 [LICENSE](LICENSE)，第三方许可证保留在各组件目录。新增 AI4Science 代码的许可证状态见 [integrations/ai4science/LICENSE](integrations/ai4science/LICENSE)，需由项目所有者决定后再正式发布。
