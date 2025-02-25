import path from 'node:path'
import MagicString from 'magic-string'
import type { EmittedAsset, OutputChunk } from 'rollup'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import type { ViteDevServer } from '../server'
import { ENV_ENTRY, ENV_PUBLIC_PATH } from '../constants'
import { cleanUrl, getHash, injectQuery, urlRE } from '../utils'
import {
  createToImportMetaURLBasedRelativeRuntime,
  onRollupWarning,
  toOutputFilePathInJS,
} from '../build'
import { fileToUrl } from './asset'

interface WorkerCache {
  // save worker all emit chunk avoid rollup make the same asset unique.
  assets: Map<string, EmittedAsset>

  // worker bundle don't deps on any more worker runtime info an id only had a result.
  // save worker bundled file id to avoid repeated execution of bundles
  // <input_filename, fileName>
  bundle: Map<string, string>

  // <hash, fileName>
  fileNameHash: Map<string, string>
}

export type WorkerType = 'classic' | 'module' | 'ignore'

export const workerOrSharedWorkerRE = /(?:\?|&)(worker|sharedworker)(?:&|$)/
const workerFileRE = /(?:\?|&)worker_file&type=(\w+)(?:&|$)/
const inlineRE = /[?&]inline\b/

export const WORKER_FILE_ID = 'worker_file'
const workerCache = new WeakMap<ResolvedConfig, WorkerCache>()

function saveEmitWorkerAsset(
  config: ResolvedConfig,
  asset: EmittedAsset,
): void {
  const fileName = asset.fileName!
  const workerMap = workerCache.get(config.mainConfig || config)!
  workerMap.assets.set(fileName, asset)
}

async function bundleWorkerEntry(
  config: ResolvedConfig,
  id: string,
): Promise<OutputChunk> {
  // bundle the file as entry to support imports
  const { rollup } = await import('rollup')
  const { plugins, rollupOptions, format } = config.worker
  const bundle = await rollup({
    ...rollupOptions,
    input: cleanUrl(id),
    plugins: await plugins(),
    onwarn(warning, warn) {
      onRollupWarning(warning, warn, config)
    },
    preserveEntrySignatures: false,
  })
  let chunk: OutputChunk
  try {
    const workerOutputConfig = config.worker.rollupOptions.output
    const workerConfig = workerOutputConfig
      ? Array.isArray(workerOutputConfig)
        ? workerOutputConfig[0] || {}
        : workerOutputConfig
      : {}
    const {
      output: [outputChunk, ...outputChunks],
    } = await bundle.generate({
      entryFileNames: path.posix.join(
        config.build.assetsDir,
        '[name]-[hash].js',
      ),
      chunkFileNames: path.posix.join(
        config.build.assetsDir,
        '[name]-[hash].js',
      ),
      assetFileNames: path.posix.join(
        config.build.assetsDir,
        '[name]-[hash].[ext]',
      ),
      ...workerConfig,
      format,
      sourcemap: config.build.sourcemap,
    })
    chunk = outputChunk
    outputChunks.forEach((outputChunk) => {
      if (outputChunk.type === 'asset') {
        saveEmitWorkerAsset(config, outputChunk)
      } else if (outputChunk.type === 'chunk') {
        saveEmitWorkerAsset(config, {
          fileName: outputChunk.fileName,
          source: outputChunk.code,
          type: 'asset',
        })
      }
    })
  } finally {
    await bundle.close()
  }
  return emitSourcemapForWorkerEntry(config, chunk)
}

function emitSourcemapForWorkerEntry(
  config: ResolvedConfig,
  chunk: OutputChunk,
): OutputChunk {
  const { map: sourcemap } = chunk

  if (sourcemap) {
    if (
      config.build.sourcemap === 'hidden' ||
      config.build.sourcemap === true
    ) {
      const data = sourcemap.toString()
      const mapFileName = chunk.fileName + '.map'
      saveEmitWorkerAsset(config, {
        fileName: mapFileName,
        type: 'asset',
        source: data,
      })
    }
  }

  return chunk
}

export const workerAssetUrlRE = /__VITE_WORKER_ASSET__([a-z\d]{8})__/g

function encodeWorkerAssetFileName(
  fileName: string,
  workerCache: WorkerCache,
): string {
  const { fileNameHash } = workerCache
  const hash = getHash(fileName)
  if (!fileNameHash.get(hash)) {
    fileNameHash.set(hash, fileName)
  }
  return `__VITE_WORKER_ASSET__${hash}__`
}

export async function workerFileToUrl(
  config: ResolvedConfig,
  id: string,
): Promise<string> {
  const workerMap = workerCache.get(config.mainConfig || config)!
  let fileName = workerMap.bundle.get(id)
  if (!fileName) {
    const outputChunk = await bundleWorkerEntry(config, id)
    fileName = outputChunk.fileName
    saveEmitWorkerAsset(config, {
      fileName,
      source: outputChunk.code,
      type: 'asset',
    })
    workerMap.bundle.set(id, fileName)
  }
  return encodeWorkerAssetFileName(fileName, workerMap)
}

export function webWorkerPostPlugin(): Plugin {
  return {
    name: 'vite:worker-post',
    resolveImportMeta(property, { format }) {
      // document is undefined in the worker, so we need to avoid it in iife
      if (format === 'iife') {
        // compiling import.meta
        if (!property) {
          // rollup only supports `url` property. we only support `url` property as well.
          // https://github.com/rollup/rollup/blob/62b648e1cc6a1f00260bb85aa2050097bb4afd2b/src/ast/nodes/MetaProperty.ts#L164-L173
          return `{
            url: self.location.href
          }`
        }
        // compiling import.meta.url
        if (property === 'url') {
          return 'self.location.href'
        }
      }

      return null
    },
  }
}

export function webWorkerPlugin(config: ResolvedConfig): Plugin {
  const isBuild = config.command === 'build'
  let server: ViteDevServer
  const isWorker = config.isWorker

  return {
    name: 'vite:worker',

    configureServer(_server) {
      server = _server
    },

    buildStart() {
      if (isWorker) {
        return
      }
      workerCache.set(config, {
        assets: new Map(),
        bundle: new Map(),
        fileNameHash: new Map(),
      })
    },

    load(id) {
      if (isBuild && workerOrSharedWorkerRE.test(id)) {
        return ''
      }
    },

    shouldTransformCachedModule({ id }) {
      if (isBuild && config.build.watch && workerOrSharedWorkerRE.test(id)) {
        return true
      }
    },

    async transform(raw, id) {
      const workerFileMatch = workerFileRE.exec(id)
      if (workerFileMatch) {
        // if import worker by worker constructor will have query.type
        // other type will be import worker by esm
        const workerType = workerFileMatch[1] as WorkerType
        let injectEnv = ''

        const scriptPath = JSON.stringify(
          path.posix.join(config.base, ENV_PUBLIC_PATH),
        )

        if (workerType === 'classic') {
          injectEnv = `importScripts(${scriptPath})\n`
        } else if (workerType === 'module') {
          injectEnv = `import ${scriptPath}\n`
        } else if (workerType === 'ignore') {
          if (isBuild) {
            injectEnv = ''
          } else if (server) {
            // dynamic worker type we can't know how import the env
            // so we copy /@vite/env code of server transform result into file header
            const { moduleGraph } = server
            const module = moduleGraph.getModuleById(ENV_ENTRY)
            injectEnv = module?.transformResult?.code || ''
          }
        }
        if (injectEnv) {
          const s = new MagicString(raw)
          s.prepend(injectEnv)
          return {
            code: s.toString(),
            map: s.generateMap({ hires: 'boundary' }),
          }
        }
        return
      }

      const workerMatch = workerOrSharedWorkerRE.exec(id)
      if (!workerMatch) return

      // stringified url or `new URL(...)`
      let url: string
      const { format } = config.worker
      const workerConstructor =
        workerMatch[1] === 'sharedworker' ? 'SharedWorker' : 'Worker'
      const workerType = isBuild
        ? format === 'es'
          ? 'module'
          : 'classic'
        : 'module'
      const workerTypeOption = `{
        ${workerType === 'module' ? `type: "module",` : ''}
        name: options?.name
      }`

      if (isBuild) {
        if (inlineRE.test(id)) {
          const chunk = await bundleWorkerEntry(config, id)
          const encodedJs = `const encodedJs = "${Buffer.from(
            chunk.code,
          ).toString('base64')}";`

          const code =
            // Using blob URL for SharedWorker results in multiple instances of a same worker
            workerConstructor === 'Worker'
              ? `${encodedJs}
          const blob = typeof window !== "undefined" && window.Blob && new Blob([${
            workerType === 'classic'
              ? ''
              : // `URL` is always available, in `Worker[type="module"]`
                `'URL.revokeObjectURL(import.meta.url);'+`
          }atob(encodedJs)], { type: "text/javascript;charset=utf-8" });
          export default function WorkerWrapper(options) {
            let objURL;
            try {
              objURL = blob && (window.URL || window.webkitURL).createObjectURL(blob);
              if (!objURL) throw ''
              const worker = new ${workerConstructor}(objURL, ${workerTypeOption});
              worker.addEventListener("error", () => {
                (window.URL || window.webkitURL).revokeObjectURL(objURL);
              });
              return worker;
            } catch(e) {
              return new ${workerConstructor}(
                "data:text/javascript;base64," + encodedJs,
                ${workerTypeOption}
              );
            }${
              // For module workers, we should not revoke the URL until the worker runs,
              // otherwise the worker fails to run
              workerType === 'classic'
                ? ` finally {
                    objURL && (window.URL || window.webkitURL).revokeObjectURL(objURL);
                  }`
                : ''
            }
          }`
              : `${encodedJs}
          export default function WorkerWrapper(options) {
            return new ${workerConstructor}(
              "data:text/javascript;base64," + encodedJs,
              ${workerTypeOption}
            );
          }
          `

          return {
            code,
            // Empty sourcemap to suppress Rollup warning
            map: { mappings: '' },
          }
        } else {
          url = await workerFileToUrl(config, id)
        }
      } else {
        url = await fileToUrl(cleanUrl(id), config, this)
        url = injectQuery(url, `${WORKER_FILE_ID}&type=${workerType}`)
      }

      if (urlRE.test(id)) {
        return {
          code: `export default ${JSON.stringify(url)}`,
          map: { mappings: '' }, // Empty sourcemap to suppress Rollup warning
        }
      }

      return {
        code: `export default function WorkerWrapper(options) {
          return new ${workerConstructor}(
            ${JSON.stringify(url)},
            ${workerTypeOption}
          );
        }`,
        map: { mappings: '' }, // Empty sourcemap to suppress Rollup warning
      }
    },

    renderChunk(code, chunk, outputOptions) {
      let s: MagicString
      const result = () => {
        return (
          s && {
            code: s.toString(),
            map: config.build.sourcemap
              ? s.generateMap({ hires: 'boundary' })
              : null,
          }
        )
      }
      workerAssetUrlRE.lastIndex = 0
      if (workerAssetUrlRE.test(code)) {
        const toRelativeRuntime = createToImportMetaURLBasedRelativeRuntime(
          outputOptions.format,
          config.isWorker,
        )

        let match: RegExpExecArray | null
        s = new MagicString(code)
        workerAssetUrlRE.lastIndex = 0

        // Replace "__VITE_WORKER_ASSET__5aa0ddc0__" using relative paths
        const workerMap = workerCache.get(config.mainConfig || config)!
        const { fileNameHash } = workerMap

        while ((match = workerAssetUrlRE.exec(code))) {
          const [full, hash] = match
          const filename = fileNameHash.get(hash)!
          const replacement = toOutputFilePathInJS(
            filename,
            'asset',
            chunk.fileName,
            'js',
            config,
            toRelativeRuntime,
          )
          const replacementString =
            typeof replacement === 'string'
              ? JSON.stringify(replacement).slice(1, -1)
              : `"+${replacement.runtime}+"`
          s.update(match.index, match.index + full.length, replacementString)
        }
      }
      return result()
    },

    generateBundle(opts) {
      // @ts-expect-error asset emits are skipped in legacy bundle
      if (opts.__vite_skip_asset_emit__ || isWorker) {
        return
      }
      const workerMap = workerCache.get(config)!
      workerMap.assets.forEach((asset) => {
        this.emitFile(asset)
        workerMap.assets.delete(asset.fileName!)
      })
    },
  }
}
