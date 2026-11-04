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

Either side may fail to open; the page then shows it offline instead of refusing to start. Native greenhouse profiles show the mounted team independently of the Router CLI link.

## Views

Overview (KPIs, fused constellation, unified timeline, budget ring) · Experiments · Providers · Artifacts · Orchestration runs (kanban, mailbox, live SSE console, interject, threads/logs) · Fleet. `Ctrl K` opens the command palette; `1`–`6` switch views. The UI defaults to Chinese; the 中文/EN button in the top bar switches language (remembered per browser). Strings live in `public/i18n.js` — Chinese is the source text, English a dictionary keyed by it. The light theme is the default; the moon/sun button switches to a dark instrument-panel theme (graphite, amber signal colour, fine grid, radar sweep) without reloading, also remembered per browser. Running work animates in both themes — flowing links in the constellation, a beam under the top bar, scan lines on in-progress tasks, a LIVE console. Motion honours `prefers-reduced-motion`.

## Probe

```bash
npx vitest run --config integrations/mission-control/vitest.config.ts
```
