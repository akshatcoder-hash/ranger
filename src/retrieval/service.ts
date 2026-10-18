import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { RangerConfig } from '../config.js';
import { Errors } from '../errors.js';
import { ProjectMirror, mirrorRootFor } from './mirror.js';
import { TraceMcpClient } from './trace-mcp.js';
import { indexMirror, runIndexedExclusively, type TraceIndexStats } from './trace-index.js';
import { TRACE_SUPPORTED_EXTENSIONS, TRACE_SUPPORTED_LANGUAGES, verifyTracePin } from './trace-pin.js';
import { readSourceFile, listSourceFiles } from '../workspace/store.js';

/**
 * Project-scoped Trace retrieval over the real pinned Trace MCP server.
 *
 * - One mirror + one index per project under the Ranger data dir / TRACE_HOME,
 *   never shared across projects.
 * - Indexing and queries run serialized through one exclusive queue, and a
 *   reindex closes the old MCP runtime and spawns a fresh one (a long-lived
 *   runtime keeps stale revision/vector references).
 * - Every citation is re-verified against the CURRENT saved source before it
 *   is served: a hash mismatch is stale, dropped, and counted, never served.
 * - Unsupported-language content is served through the clearly labeled
 *   file-search fallback. Trace being unavailable is an explicit failure,
 *   never silently substituted.
 */

const OUTPUT_PREVIEW_CAP = 400;

export interface RetrievalStatus {
  provider: 'trace';
  indexed: boolean;
  snapshotId: string | null;
  lastIndexedAt: string | null;
  languages: string[];
}

export interface RetrievalResult {
  filePath: string;
  startLine: number;
  endLine: number;
  snapshotId: string;
  commit: string;
  branch: string;
  dirty: boolean;
  contentHash: string;
  score: number;
  verbatim: boolean;
  uncertain: boolean;
  /** The evidence snippet, capped; verbatim means it equals the cited lines. */
  snippet?: string;
}

export interface RetrievalSearchResponse {
  provider: 'trace' | 'file-search-fallback';
  results: RetrievalResult[];
  staleDropped?: number;
}

interface ProjectRetrievalState {
  mcp: TraceMcpClient | null;
  snapshot: TraceIndexStats | null;
  headCommit: string | null;
}

export interface RetrievalServiceOptions {
  db: DatabaseSync;
  config: RangerConfig;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isSupportedLanguage(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return TRACE_SUPPORTED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

interface EvidenceItem {
  citation?: { contentHash?: string; snapshotId?: string; startLine?: number; endLine?: number };
  filePath?: string;
  startLine?: number;
  endLine?: number;
  code?: string;
  score?: number;
  resolution?: string | null;
}

interface EvidenceBundle {
  revision?: { snapshotId?: string; commit?: string | null; branch?: string | null; dirty?: boolean };
  items?: EvidenceItem[];
}

export class RetrievalService {
  private readonly states = new Map<string, ProjectRetrievalState>();

  constructor(private readonly options: RetrievalServiceOptions) {}

  status(projectId: string): RetrievalStatus {
    const state = this.states.get(projectId);
    return {
      provider: 'trace',
      indexed: state?.snapshot !== undefined && state?.snapshot !== null,
      snapshotId: state?.snapshot?.snapshotId ?? null,
      lastIndexedAt: state?.snapshot?.indexedAt ?? null,
      languages: [...TRACE_SUPPORTED_LANGUAGES],
    };
  }

  /**
   * Reindex one project: sync the mirror from saved source, run the real
   * Trace index with the cached model, then restart the MCP runtime. All
   * index/restart work is serialized process-wide.
   */
  async reindex(projectId: string): Promise<RetrievalStatus> {
    const pin = await verifyTracePin({
      traceRoot: this.options.config.providers.traceRoot,
      pinnedCommit: this.options.config.providers.tracePinnedCommit,
    });
    void pin;
    const mirror = this.mirrorFor(projectId);
    const state = this.stateFor(projectId);
    const snapshot = await runIndexedExclusively(async () => {
      const synced = await mirror.sync(this.options.db, projectId);
      const stats = await indexMirror({
        traceRoot: this.options.config.providers.traceRoot,
        mirrorRoot: mirror.root,
        traceHome: this.options.config.providers.traceHome,
      });
      // Restart the MCP runtime: the old child holds the previous snapshot.
      const previous = state.mcp;
      state.mcp = null;
      if (previous !== null) await previous.close();
      const mcp = TraceMcpClient.spawn({
        traceRoot: this.options.config.providers.traceRoot,
        mirrorRoot: mirror.root,
        traceHome: this.options.config.providers.traceHome,
      });
      try {
        await mcp.initialize();
      } catch (cause) {
        await mcp.close();
        throw cause;
      }
      state.mcp = mcp;
      state.headCommit = synced.headCommit;
      state.snapshot = stats;
      return stats;
    });
    return {
      provider: 'trace',
      indexed: true,
      snapshotId: snapshot.snapshotId,
      lastIndexedAt: snapshot.indexedAt,
      languages: [...TRACE_SUPPORTED_LANGUAGES],
    };
  }

  async search(projectId: string, query: string, limit: number): Promise<RetrievalSearchResponse> {
    // Serialized with indexing: a search never races a reindex or reads a
    // closing MCP runtime.
    return runIndexedExclusively(async () => {
      const state = this.stateFor(projectId);
      if (state.snapshot === null) {
        throw Errors.conflict('Retrieval index does not exist for this project yet', {
          reason: 'retrieval_not_indexed',
        });
      }
      if (state.mcp === null) {
        throw Errors.notConfigured('Trace retrieval runtime is not running for this project', {
          reason: 'trace_unavailable',
        });
      }
      const bundle = await this.callSearch(state, query, limit);
      const items = Array.isArray(bundle.items) ? (bundle.items as EvidenceItem[]) : [];
      const verified = this.verifyCitations(projectId, items, state, bundle);
      // Identifier-shaped queries must actually mention the token: Trace has
      // no relevance threshold and vector-only neighbors for an absent
      // identifier are not evidence. Natural-language queries pass through
      // with their uncertainty labels instead.
      const gated = filterIdentifierQueries(query, verified.results);
      if (gated.length > 0) {
        return { provider: 'trace', results: gated, staleDropped: verified.staleDropped };
      }
      // No usable Trace result (nothing found, every citation stale, or an
      // identifier the project does not mention). The labeled fallback covers
      // only content Trace cannot index at all.
      const fallback = this.fallbackSearch(projectId, query, limit);
      if (fallback.length > 0) {
        return { provider: 'file-search-fallback', results: fallback, staleDropped: verified.staleDropped };
      }
      return { provider: 'trace', results: [], staleDropped: verified.staleDropped };
    });
  }

  async closeAll(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.mcp !== null) {
        const mcp = state.mcp;
        state.mcp = null;
        await mcp.close();
      }
    }
  }

  /** Labeled file-search fallback for unsupported-language content. */
  private fallbackSearch(projectId: string, query: string, limit: number): RetrievalResult[] {
    const state = this.states.get(projectId);
    const files = listSourceFiles(this.options.db, projectId, '');
    const results: RetrievalResult[] = [];
    const needle = query.toLowerCase();
    for (const file of files) {
      if (isSupportedLanguage(file.path)) continue;
      const content = readSourceFile(this.options.db, projectId, file.path);
      if (content === null) continue;
      const head = state?.headCommit ?? '';
      const lines = content.toString('utf8').split('\n');
      for (let index = 0; index < lines.length && results.length < limit; index += 1) {
        if (lines[index] !== undefined && lines[index]!.toLowerCase().includes(needle)) {
          results.push({
            filePath: file.path,
            startLine: index + 1,
            endLine: index + 1,
            snapshotId: head !== '' ? head : 'uncommitted-mirror',
            commit: head,
            branch: 'main',
            dirty: false,
            contentHash: sha256(content),
            score: 1,
            verbatim: true,
            uncertain: false,
            snippet: lines[index]!.slice(0, 2000),
          });
        }
      }
    }
    return results;
  }

  private async callSearch(state: ProjectRetrievalState, query: string, limit: number): Promise<EvidenceBundle> {
    const mcp = state.mcp;
    if (mcp === null) {
      throw Errors.notConfigured('Trace retrieval is not available', { reason: 'trace_unavailable' });
    }
    try {
      const result = await mcp.callTool('search_code', { query, maxItems: limit });
      if (result.isError) {
        throw Errors.conflict('Trace search_code reported an error', {
          reason: 'trace_search_failed',
          detail: JSON.stringify(result.data).slice(0, OUTPUT_PREVIEW_CAP),
        });
      }
      return result.data as EvidenceBundle;
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && (cause as { code?: string }).code === 'not_configured') {
        throw cause;
      }
      throw Errors.notConfigured('Trace retrieval runtime is unavailable', {
        reason: 'trace_unavailable',
        detail: cause instanceof Error ? cause.message.slice(0, OUTPUT_PREVIEW_CAP) : String(cause).slice(0, OUTPUT_PREVIEW_CAP),
        diagnostics: mcp.diagnostics(),
      });
    }
  }

  /**
   * Re-verify every citation against the CURRENT saved source before use.
   * A hash mismatch is stale: dropped and counted, never served. Verbatim
   * means the returned snippet equals the cited lines in the saved source.
   */
  private verifyCitations(
    projectId: string,
    items: EvidenceItem[],
    state: ProjectRetrievalState,
    bundle: EvidenceBundle,
  ): { results: RetrievalResult[]; staleDropped: number } {
    const results: RetrievalResult[] = [];
    let staleDropped = 0;
    for (const item of items) {
      const filePath = item.filePath;
      const contentHash = item.citation?.contentHash;
      if (typeof filePath !== 'string' || typeof contentHash !== 'string') {
        staleDropped += 1;
        continue;
      }
      const content = readSourceFile(this.options.db, projectId, filePath);
      if (content === null || sha256(content) !== contentHash) {
        staleDropped += 1;
        continue;
      }
      const startLine = Number(item.startLine ?? item.citation?.startLine ?? 0);
      const endLine = Number(item.endLine ?? item.citation?.endLine ?? 0);
      const snapshotId = String(bundle.revision?.snapshotId ?? item.citation?.snapshotId ?? state.snapshot?.snapshotId ?? '');
      if (startLine < 1 || endLine < startLine || snapshotId === '') {
        staleDropped += 1;
        continue;
      }
      const citedText = readCitedLines(content, startLine, endLine);
      const verbatim = citedText !== null && item.code !== undefined && item.code === citedText;
      const resolution = item.resolution;
      results.push({
        filePath,
        startLine,
        endLine,
        snapshotId,
        commit: String(bundle.revision?.commit ?? state.headCommit ?? ''),
        branch: String(bundle.revision?.branch ?? 'main'),
        dirty: bundle.revision?.dirty === true,
        contentHash,
        score: Number(item.score ?? 0),
        verbatim,
        uncertain: !verbatim || (resolution !== null && resolution !== undefined && resolution !== 'resolved'),
        snippet: typeof item.code === 'string' ? item.code.slice(0, 2000) : undefined,
      });
    }
    return { results, staleDropped };
  }

  private stateFor(projectId: string): ProjectRetrievalState {
    let state = this.states.get(projectId);
    if (state === undefined) {
      state = { mcp: null, snapshot: null, headCommit: null };
      this.states.set(projectId, state);
    }
    return state;
  }

  private mirrorFor(projectId: string): ProjectMirror {
    return new ProjectMirror(mirrorRootFor(this.options.config.dataDir, projectId));
  }
}

function readCitedLines(content: Buffer, startLine: number, endLine: number): string | null {
  const lines = content.toString('utf8').split('\n');
  if (endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * Relevance floor for identifier-shaped queries (single tokens and qualified
 * names). Every served result must mention at least one token of the query in
 * its snippet or path; otherwise Trace's threshold-free vector channel would
 * dress neighbors up as evidence for an identifier that is absent here.
 */
function filterIdentifierQueries(query: string, results: RetrievalResult[]): RetrievalResult[] {
  if (!/^[\w$.-]+$/.test(query.trim())) return results;
  const tokens = query.toLowerCase().split(/[.$-]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return results;
  return results.filter((result) => {
    const haystack = `${result.filePath}\n${result.snippet ?? ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}
