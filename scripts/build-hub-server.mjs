#!/usr/bin/env node

/** Bundle the Hub server and its internal workspace packages into one ESM file. */

import { resolve } from 'node:path'
import { build } from 'esbuild'

const repositoryRoot = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? resolve(repositoryRoot, 'dist', 'hub-server.mjs'))

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: ['packages/hub/hub-server/src/bin.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: ['node:*'],
  plugins: [{
    name: 'hub-workspace-source',
    setup(esbuild) {
      esbuild.onResolve({ filter: /^@k1412\/dsh-hub-/ }, args => ({
        path: resolve(
          repositoryRoot,
          'packages',
          'hub',
          args.path.slice('@k1412/dsh-'.length),
          'src',
          'index.ts',
        ),
      }))
    },
  }],
})
