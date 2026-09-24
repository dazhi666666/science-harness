/** File-based deployment configuration and independent provider module loading. No scientific roles are built in. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { validateProvider, type Json, type ExecutionProvider } from './sdk.ts'
import { ExecutionEngine } from './execution.ts'

import { HARNESS_BASELINE } from './version.ts'
export { HARNESS_BASELINE } from './version.ts'
export const PLATFORM_VERSION = '0.2.0'
const schema = z
  .object({
    apiVersion: z.literal(1),
    enabled: z.literal(true),
    baseline: z.literal(HARNESS_BASELINE),
    directory: z.string().min(1),
    providerCallTimeoutMs: z.number().int().min(1).max(300000),
    pollIntervalMs: z.number().int().min(1).max(60000),
    management: z
      .object({
        actorId: z.string().min(1),
        projects: z.array(z.string().min(1)).min(1),
        allowedProviders: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    providers: z
      .array(z.object({ module: z.string().min(1), config: z.record(z.string(), z.json()) }).strict())
      .min(1),
    organization: z.unknown().optional(),
  })
  .strict()
export type PlatformConfig = z.infer<typeof schema>

/** Parse a deployment file. Provider modules/configuration are trusted executable installation inputs. */
export function readPlatformConfig(path: string): PlatformConfig {
  const config = schema.parse(JSON.parse(readFileSync(path, 'utf8')))
  config.directory = resolve(dirname(path), config.directory)
  for (const provider of config.providers) {
    provider.module = resolve(dirname(path), provider.module)
    if (typeof provider.config.directory === 'string')
      provider.config.directory = resolve(dirname(path), provider.config.directory)
  }
  return config
}

/** Register independently authored factories through the public API; fail on disabled or incompatible configuration. */
export async function openConfiguredEngine(
  path: string,
): Promise<{ engine: ExecutionEngine; config: PlatformConfig }> {
  const config = readPlatformConfig(resolve(path))
  const providers: ExecutionProvider[] = []
  for (const entry of config.providers) {
    const module = (await import(pathToFileURL(entry.module).href)) as {
      createProvider?: (config: Json) => ExecutionProvider | Promise<ExecutionProvider>
    }
    if (typeof module.createProvider !== 'function')
      throw new Error(`Provider module must export createProvider: ${entry.module}`)
    providers.push(validateProvider(await module.createProvider(entry.config as Json)))
  }
  const ids = providers.map((p) => p.describe().id)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate provider ID')
  if (config.management.allowedProviders.some((id) => !ids.includes(id)))
    throw new Error('Management permission references an unregistered provider')
  const engine = new ExecutionEngine({
    directory: config.directory,
    providers,
    pollIntervalMs: config.pollIntervalMs,
    providerCallTimeoutMs: config.providerCallTimeoutMs,
  })
  await engine.open()
  return { engine, config }
}
