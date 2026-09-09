/** One checked-in host baseline shared by plugin configuration, examples and verification. */
import { readFileSync } from 'node:fs'
const metadata = JSON.parse(readFileSync(new URL('../../../UPSTREAM.json', import.meta.url), 'utf8')) as { upstreamCommit: string }
if (!/^[a-f0-9]{40}$/.test(metadata.upstreamCommit)) throw new Error('Invalid pinned Harness revision in UPSTREAM.json')
export const HARNESS_BASELINE = metadata.upstreamCommit
