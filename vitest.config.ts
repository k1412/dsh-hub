import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const hub = (name: string): string => resolve(import.meta.dirname, `packages/hub/${name}/src/index.ts`)

export default defineConfig({
  resolve: {
    alias: {
      '@k1412/dsh-gateway-session-directory': hub('gateway-session-directory'),
      '@k1412/dsh-gateway-server': hub('gateway-server'),
      '@k1412/dsh-gateway-network': hub('gateway-network'),
      '@k1412/dsh-gateway-node': hub('gateway-node'),
      '@k1412/dsh-gateway-transport': hub('gateway-transport'),

      '@deepseek-ai/dsh-client-ui-primitives': resolve(
        import.meta.dirname,
        'packages/hub/hub-client-ui/tests/primitives.stub.tsx',
      ),
      '@k1412/dsh-hub-protocol': hub('hub-protocol'),
      '@k1412/dsh-hub-capabilities': hub('hub-capabilities'),
      '@k1412/dsh-hub-transport': hub('hub-transport'),
      '@k1412/dsh-hub-storage': hub('hub-storage'),
      '@k1412/dsh-hub-node-ipc': hub('hub-node-ipc'),
      '@k1412/dsh-hub-node-agent': hub('hub-node-agent'),
      '@k1412/dsh-hub-connector': hub('hub-connector'),
      '@k1412/dsh-hub-client-ui': hub('hub-client-ui'),
      '@k1412/dsh-hub-server': hub('hub-server'),
    },
  },
  test: {
    include: [
      'packages/hub/*/tests/**/*.spec.{ts,tsx}',
      'apps/hub-web/tests/**/*.spec.ts',
    ],
    pool: 'forks',
  },
})
