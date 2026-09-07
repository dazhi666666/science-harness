/** Project artifacts with content hashes and source identities. Scientific interpretation is scenario-owned. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import type { ExecutionEngine } from './execution.ts'
import type { OperationContext, Json } from './sdk.ts'

export interface ProjectArtifact {
  id: string
  projectId: string
  actorId: string
  path: string
  sha256: string
  bytes: number
  mediaType: string
  sources: string[]
}
/** All metadata lives in the engine's transaction database, not a parallel artifact index. */
export class Artifacts {
  constructor(private readonly engine: ExecutionEngine) {}
  list(context: OperationContext): ProjectArtifact[] {
    return this.engine
      .readFacts(context)
      .filter((f) => f.kind === 'artifact-published')
      .map((f) => f.data as unknown as ProjectArtifact)
  }
  /** Resolve only artifacts from this project and the currently granted Provider scope. */
  read(
    context: OperationContext,
    id: string,
    visiting = new Set<string>(),
  ): { artifact: ProjectArtifact; content: string; encoding: 'utf8' | 'base64' } {
    if (visiting.has(id)) throw new Error('Artifact provenance cycle')
    visiting.add(id)
    const operations = this.engine.list(context)
    const candidates = operations.flatMap((o) =>
      o.artifacts.map((a) => ({ ...a, projectId: o.projectId, actorId: o.actorId, sources: [] })),
    )
    const artifact = [...candidates, ...this.list(context)].find((a) => a.id === id)
    if (!artifact) throw new Error('Unknown or inaccessible artifact')
    for (const source of artifact.sources) this.read(context, source, new Set(visiting))
    const base = realpathSync(this.engine.directory)
    const path = realpathSync(resolve(base, artifact.path))
    const rel = relative(base, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact path escaped project store')
    const bytes = readFileSync(path)
    if (
      bytes.length !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new Error('Artifact integrity check failed')
    const encoding =
      artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json' ? 'utf8' : 'base64'
    return { artifact, content: bytes.toString(encoding), encoding }
  }
  /** Publish bounded text and validated source references; a database failure can leave an unreferenced file, never a false result. */
  publish(
    context: OperationContext,
    input: { content: string; mediaType: string; sources: string[] },
  ): ProjectArtifact {
    this.engine.list(context)
    if (
      !['text/plain', 'text/markdown', 'application/json'].includes(input.mediaType) ||
      Buffer.byteLength(input.content) > 1048576
    )
      throw new Error('Unsupported or oversized text artifact')
    if (input.mediaType === 'application/json') JSON.parse(input.content)
    for (const source of input.sources) this.read(context, source)
    const id = randomUUID()
    const directory = resolve(this.engine.directory, 'project-artifacts')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = resolve(directory, id)
    writeFileSync(path, input.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const artifact: ProjectArtifact = {
      id,
      projectId: context.projectId,
      actorId: context.actorId,
      path: relative(this.engine.directory, path),
      sha256: createHash('sha256').update(input.content).digest('hex'),
      bytes: Buffer.byteLength(input.content),
      mediaType: input.mediaType,
      sources: [...new Set(input.sources)],
    }
    this.engine.recordFact(context, 'artifact-published', artifact as unknown as Json)
    return artifact
  }
}
