/** Types for the copied plain-.mjs Agent Router modules (they carry no bundled declarations). */

export interface AgentRouterRun {
  id: string
  status: string
  child: import('node:child_process').ChildProcess
}

export interface AgentRouterRuns {
  readonly active: Map<string, AgentRouterRun>
  kill(child: import('node:child_process').ChildProcess): void
}

export interface AgentRouterApp {
  server: import('node:http').Server
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
  runs: AgentRouterRuns
}

export type AgentRouterModules = {
  createApp(options?: { dataDir?: string }): AgentRouterApp
}
