# Mission Control

把两套自研界面——**AI4Science 仪表盘**（科学执行）与 **Agent Router 控制台**（多智能体编排）——融合为一个带动效的“任务控制中心”单页。两边的界面与后端代码都不改：

- Agent Router 的 `createApp().handler` 在进程内挂在 `/router/*`；
- AI4Science 仪表盘保留自己的回环监听与令牌，经 `/science/*` 反向代理。

## 启动（仅通过 profile）

```bash
pnpm dsh --profile web --patch integrations/mission-control/mission-control.patch.yml
```

打开打印出的 `Mission Control: http://127.0.0.1:2300/#<token>` 链接；令牌会换成 HttpOnly SameSite Cookie，所有 API 都需要它。

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `MISSION_CONTROL_PORT` | `2300` | 页面端口 |
| `SCIENCE_CONFIG` | 内置合成示例 | AI4Science 平台 JSON；`off` 关闭科学侧 |
| `AGENT_ROUTER_DATA_DIR` | `integrations/agent-router/data` | 编排运行数据 |

任一侧打开失败时，页面把该侧显示为离线，而不是拒绝启动。

## 视图

总览（KPI、融合星座图、统一时间线、预算环）· 实验运行 · Provider · 研究产物 · 编排运行（看板、信箱、SSE 实时控制台、插话、线程/日志）· 成员舰队。`Ctrl K` 打开命令面板，`1`–`6` 切换视图；动效遵循 `prefers-reduced-motion`。

## 探针

```bash
npx vitest run --config integrations/mission-control/vitest.config.ts
```
