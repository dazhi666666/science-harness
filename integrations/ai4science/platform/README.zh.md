# AI4Science 智能体工具

[English](README.md) | 中文

## 接口参考

组织工具接受明确的成员 ID 或唯一可见角色：`org_message` 和 `org_send_result` 使用 `target_id` 或 `target_role`；`org_authorize` 使用 `child_id` 或 `child_role`，以及 `peer_child_id` 或 `peer_role`。每个成员必须且只能提供一种选择方式。按角色寻址还要求调用者的工具白名单包含 `org_discover`。角色不存在或有歧义时报错；发现成员不代表获得授权。原生父子关系、双方父节点同意和结果访问检查继续生效。工具响应包含解析后的真实 ID，原有 ID 调用继续兼容。

`execution_facts(operations_only=true)` 返回可访问操作，不附项目历史；省略该字段保留完整响应。已知操作时使用 `execution_result(operation_id)` 直接读取。

[first-loop 场景](scenes/first-loop.ts)接受结构化参数：`scenario_submit(requestKey, phase, conditions, decisionId?)`、`scenario_analyze(operationIds, method, rationale)`、`scenario_choose_followup(branch, analysisIds, conditions, rationale)`。每个条件包含 `value` 和 `samples`。这些工具不再接受编码在 `request_json` 内的 JSON；参见[迁移指南](../../../docs/upgrade-guide/v0.2.1-alpha.2/science-scene-tools/guide.zh.md)。

`scenario_report(markdown, source_ids?)` 根据指向现有项目产物与操作输出文件的链接推导来源。项目路径会规范化为相对报告目录的路径；来源必须可访问且通过大小与哈希检查。显式 `source_ids` 必须是正文中有链接的产物 ID，不能是操作 ID。`project-artifacts/`、`artifacts/` 或 `../artifacts/` 下的失效链接会被拒绝。不评估科研结论正确性。

场景的 Loader 入口 `apply` 不返回安装对象；进程内组合使用 `mountScene`。场景专用的分支名称与实验阶段仍仅属于该示例。这些工具改动不引入固定团队人数、强制消息交流、模型请求预算或项目运行时限；执行和实验策略仍由各自配置管理。
