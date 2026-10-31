# Mission Control

One loopback page that fuses the two self-written UIs — the **AI4Science dashboard** (science execution) and the **Agent Router console** (multi-agent orchestration) — into a single animated "mission control" interface. Neither source UI or backend is modified:

- the Agent Router `createApp().handler` runs in-process under `/router/*`;
- the AI4Science dashboard keeps its own loopback listener and bearer and is reverse-proxied under `/science/*`.

## Launch (profile only)

```bash
pnpm dsh --profile web --patch integrations/mission-control/mission-control.patch.yml
```

Open the printed `Mission Control: http://127.0.0.1:2300/#<token>` link. The token is exchanged for an HttpOnly SameSite cookie; every API path requires it.

| Env | Default | Meaning |
| --- | --- | --- |
| `MISSION_CONTROL_PORT` | `2300` | page port |
| `SCIENCE_CONFIG` | bundled synthetic example | AI4Science platform JSON; `off` disables the science side |
| `AGENT_ROUTER_DATA_DIR` | `integrations/agent-router/data` | router run data |

Either side may fail to open; the page then shows it offline instead of refusing to start.

## Views

Overview (KPIs, fused constellation, unified timeline, budget ring) · Experiments · Providers · Artifacts · Orchestration runs (kanban, mailbox, live SSE console, interject, threads/logs) · Fleet. `Ctrl K` opens the command palette; `1`–`6` switch views. Motion honours `prefers-reduced-motion`.

## Probe

```bash
npx vitest run --config integrations/mission-control/vitest.config.ts
```
