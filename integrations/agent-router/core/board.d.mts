/** Types for the existing Agent Router task board; runtime behavior remains in board.mjs. */
import { EventEmitter } from 'node:events'

export interface RouterTask {
  id: string
  title: string
  spec: string
  assignee: string
  blocked_by: string[]
  isolated: boolean
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  result: string | null
  artifacts: string[]
  created_by: string
  created_at: string
  updated_at: string
  updated_by?: string
  started_at?: string
  finished_at?: string
}
export interface RouterMessage {
  id: string
  from: string
  to: string
  task_id: string | null
  content: string
  read: boolean
  ts: string
  readBy?: string[]
}
/** Task and mailbox state owned by one running Router/application instance. */
export class Board extends EventEmitter {
  constructor(file: string)
  readonly file: string
  readonly tasks: RouterTask[]
  readonly messages: RouterMessage[]
  readonly finished: { summary: string; at: string; by: string } | null
  save(): void
  task(id: string): RouterTask | null
  createTask(input: { title: string; spec?: string; assignee: string; blocked_by?: string[]; isolated?: boolean }, by: string): RouterTask
  updateTask(id: string, patch: Partial<Pick<RouterTask, 'status' | 'result' | 'artifacts' | 'spec'>>, by?: string): RouterTask | null
  sendMessage(input: { from: string; to: string; content: string; task_id?: string | null }): RouterMessage
  inbox(name: string, options?: { unreadOnly?: boolean; markRead?: boolean }): RouterMessage[]
  finish(summary: string, by: string): void
}
