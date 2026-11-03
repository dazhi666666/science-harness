---
kind: upgrade-guide
description: "AI4Science first-loop 工具将 JSON 字符串替换为结构化字段，进程内组合改用 mountScene。"
---
# first-loop 场景的结构化工具

[English](guide.md) | 中文

## 变更

可选的 AI4Science first-loop 场景将 `request_json` 替换为直接的工具字段。其 Loader 入口 `apply` 返回 void；需要读取已安装服务的组合使用 `mountScene`。已有的持久化操作与产物不变。

## 迁移

1. 更新提示词和脚本工具调用：将原 JSON 对象的字段直接传给 `scenario_submit`、`scenario_analyze` 或 `scenario_choose_followup`。参见[工具参考](../../../../integrations/ai4science/platform/README.zh.md)。
2. 将读取场景 `apply(ctx, config)` 返回值的进程内调用改为 `mountScene(ctx, config)`。Loader 配置仍加载同一模块。
3. 在仓库根目录运行 `pnpm exec vitest run --config integrations/ai4science/platform/vitest.config.ts`，检查真实 Loader 入口和提供方、工具集成，不调用外部模型。
