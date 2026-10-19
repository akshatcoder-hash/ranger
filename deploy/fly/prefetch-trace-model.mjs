/**
 * Download the pinned Trace embedding model into TRACE_HOME before the API
 * serves traffic. Indexing and MCP refuse to download, so an empty volume
 * would otherwise report Trace as present while retrieval cannot embed.
 * Loads the real transformers pipeline, then disposes it; no provider calls.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const MODEL_ID = 'jinaai/jina-embeddings-v2-base-code';
const REVISION = '516f4baf13dec4ddddda8631e019b5737c8bc250';
const cacheDir = `${process.env.TRACE_HOME ?? '/data/trace'}/models`;
const require = createRequire('/app/trace/packages/core/package.json');
const transformersUrl = pathToFileURL(require.resolve('@huggingface/transformers')).href;
const transformers = await import(transformersUrl);

transformers.env.useBrowserCache = false;
const pipeline = await transformers.pipeline('feature-extraction', MODEL_ID, {
  revision: REVISION,
  dtype: 'q8',
  device: 'cpu',
  cache_dir: cacheDir,
  local_files_only: false,
});
if (typeof pipeline.dispose === 'function') await pipeline.dispose();
process.stdout.write(`${JSON.stringify({ msg: 'trace model prefetched', cacheDir, model: MODEL_ID, revision: REVISION })}\n`);
