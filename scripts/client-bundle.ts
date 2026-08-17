/** Hub-owned preset for producing one DSH Web client-plugin artifact. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const
const CLIENT_EXTERNALS = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']
const CSS_PREFIX = '\0dsh-hub-css:'
const CSS_SUFFIX = '.mjs'
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')

function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physical = resolve(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physical).split(sep).join('/')
  return repositoryPath.startsWith('packages/') ? `../../../${repositoryPath}` : source
}

export function clientBundle(id: string, libEntry: readonly string[]) {
  return (): UserConfig[] => [{
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }, {
    name: `${id}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS,
      alwaysBundle: (name: string) => CLIENT_EXTERNALS.includes(name) ? undefined : true,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'dsh-hub-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        return CSS_PREFIX + (importer === undefined ? source : sourceAssetPath(source, importer)) + CSS_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_PREFIX)) return null
        const fileId = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
        this.addWatchFile(fileId)
        const result = transform({
          filename: fileId,
          code: await readFile(fileId),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, value] of Object.entries(result.exports ?? {})) classMap[local] = value.name
        return [
          `const css = ${JSON.stringify(result.code.toString())};`,
          `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
          'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
          '  const tag = document.createElement("style");',
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }]
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}
