import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: { include: ['integrations/agent-router/harness/probe.spec.ts'], testTimeout: 20000 },
})
