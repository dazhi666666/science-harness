---
kind: upgrade-guide
description: "温室 Agent profile 默认改为事件驱动、无总次数上限的原生重试及基于模拟步的对照字段。"
---
# 温室事件驱动 profile

[English](guide.md) | 中文

## 变更

新的温室 Agent profile 使用事件驱动模拟，替代宿主定时推进。模型生成与可执行决策期间虚拟时间保持不动；成员阻塞后才推进到下一虚拟事件。全部声明工作完成后暂停推进，宿主仍保留。仅环境 profile 保留定时模式。生成的真实模型 profile 使用原生 `retryPolicy.mode: always`，持续重试直至成功或拥有者取消／卸载。

对照报告使用 `timeReference: simulation-ticks`、`taskCompletionTick`、`taskLatencyTicks` 与 `allTaskCompletionTick`，移除墙钟完成耗时字段。匹配要求两方均采用事件驱动且虚拟时钟设置相同。旧定时试验仍保留为历史证据，但不通过该匹配条件。

## 迁移

1. 保留已有运行目录、源码快照及报告。Agent profile 要求新任务板，不能重启已使用试验来更换协议。
2. 使用 [install-multi.py](../../../../integrations/ai4science/greenhouse/install-multi.py) 为单／多 Agent 创建全新目录，采用相同场景、模型池及 `--clock-mode event-driven --idle-review-ticks 30`。源码编辑后重新安装未使用的 profile。`--clock-mode timer` 仅用于明确标识的旧模式诊断。
3. 报告消费者改用上述模拟步字段。保存的本机时间戳仅作为审计信息，不用于计算评测耗时。
4. 确认安装记录的 `clockPolicy` 为事件驱动，核验真实任务及产物，再运行 [compare.py](../../../../integrations/ai4science/greenhouse/compare.py)。检查时钟策略匹配及其他所有条件，解释规则见[实验协议](../../../../integrations/ai4science/greenhouse/experiments/README.zh.md)。
