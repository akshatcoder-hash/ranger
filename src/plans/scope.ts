import { Errors } from '../errors.js';

/**
 * Sandbox scope grammar and prohibited-action policy.
 *
 * Exact-version sandbox approval authorizes SCOPED SANDBOX CODING only.
 * Production deployment, purchases, access expansion, external
 * communication and destructive external actions are prohibited outright:
 * no scope entry, plan, or approval route may enable them, and the tool
 * layer refuses commands that attempt them.
 *
 * Scope entries:
 *   edit:<project-relative-prefix>  — edit_file on paths under the prefix
 *   command                         — run_command / run_tests
 *   launch                          — launch_app
 *   evidence                        — collect_evidence
 *
 * Anything else is rejected at plan creation AND approval time, so no
 * persisted record can carry a prohibited category.
 */

export const EDIT_SCOPE_PATTERN = /^edit:(?!\/)[A-Za-z0-9._/-]+$/;
export const FIXED_SCOPES = new Set(['command', 'launch', 'evidence']);

/** Read-only tools need no scope entry, only a valid approval. */
const READ_TOOLS = new Set(['inspect_file', 'list_files', 'search_code']);
const COMMAND_TOOLS = new Set(['run_command', 'run_tests']);

/**
 * Commands the tool layer refuses even when command scope is granted. These
 * are the executable shapes of the prohibited classes (deployment CLIs,
 * external transfer/communication, identity/privilege expansion). The guest
 * egress fence is the primary control; this is the tool-layer backstop.
 */
const PROHIBITED_COMMAND_BASENAMES = new Set([
  'sudo',
  'su',
  'doas',
  'kubectl',
  'helm',
  'terraform',
  'tofu',
  'pulumi',
  'aws',
  'gcloud',
  'az',
  'heroku',
  'vercel',
  'netlify',
  'fly',
  'railway',
  'curl',
  'wget',
  'http',
  'nc',
  'ncat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'sendmail',
  'mail',
  'mailx',
  'useradd',
  'adduser',
  'usermod',
  'groupadd',
]);

const METADATA_ENDPOINT = '169.254.169.254';

/** Validate scope entries against the safe grammar; prohibited input fails. */
export function validateScopeEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256 || seen.has(entry)) {
      throw Errors.validation('Plan scope entries must be unique strings', { reason: 'prohibited_scope' });
    }
    seen.add(entry);
    if (entry.startsWith('edit:')) {
      if (!EDIT_SCOPE_PATTERN.test(entry) || entry.includes('..')) {
        throw Errors.validation(
          `Plan scope entry "${entry}" is prohibited: edit entries must be relative path prefixes`,
          { reason: 'prohibited_scope', entry },
        );
      }
      continue;
    }
    if (!FIXED_SCOPES.has(entry)) {
      throw Errors.validation(
        `Plan scope entry "${entry}" is prohibited: sandbox approval authorizes scoped coding only and never deployment, purchases, access expansion, external communication or destructive actions`,
        { reason: 'prohibited_scope', entry },
      );
    }
  }
  if (seen.size === 0) {
    throw Errors.validation('Plan scope must name at least one permitted sandbox scope', { reason: 'prohibited_scope' });
  }
  return entries;
}

/** Whether an approved scope covers editing one project-relative path. */
export function scopeCoversEdit(scope: string[], path: string): boolean {
  return scope.some((entry) => {
    if (!entry.startsWith('edit:')) return false;
    const prefix = entry.slice(5);
    return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  });
}

/** Whether an approved scope covers a fixed sandbox category. */
export function scopeAllows(scope: string[], scopeName: 'command' | 'launch' | 'evidence'): boolean {
  return scope.includes(scopeName);
}

/** The scope requirement of one coding tool, or null for read-only tools. */
export function requiredScopeForTool(tool: string): 'edit' | 'command' | 'launch' | 'evidence' | null {
  if (READ_TOOLS.has(tool)) return null;
  if (tool === 'edit_file') return 'edit';
  if (COMMAND_TOOLS.has(tool)) return 'command';
  if (tool === 'launch_app') return 'launch';
  if (tool === 'collect_evidence') return 'evidence';
  // Unknown tools are never authorized by an approval.
  return 'command';
}

/** Basenames of argv candidates for the prohibition check. */
function argvBasenames(argv: string[]): string[] {
  return argv
    .filter((token) => typeof token === 'string')
    .map((token) => {
      const parts = token.split('/');
      return parts[parts.length - 1] ?? token;
    });
}

const INTERPRETERS = new Set(['bash', 'sh', 'dash', 'zsh']);
const PROHIBITED_WORD = new RegExp(`\\b(${[...PROHIBITED_COMMAND_BASENAMES].join('|')})\\b`);

/**
 * Whether a tool command targets a prohibited class. Checked on the raw
 * argv so redirects, inline shells and subcommands cannot hide the program
 * name.
 */
export function isProhibitedCommand(argv: string[]): { prohibited: boolean; reason?: string } {
  const text = argv.join(' ');
  if (text.includes(METADATA_ENDPOINT)) {
    return { prohibited: true, reason: 'metadata_endpoint_denied' };
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const basename = argvBasenames([token])[0] ?? token;
    if (PROHIBITED_COMMAND_BASENAMES.has(basename)) {
      return { prohibited: true, reason: 'prohibited_command' };
    }
    // A bare interpreter as the program is fine; any later token naming a
    // prohibited program (inline shell bodies, flag values) is refused.
    if (index === 0 && INTERPRETERS.has(token)) continue;
    if (PROHIBITED_WORD.test(token)) {
      return { prohibited: true, reason: 'prohibited_command' };
    }
  }
  return { prohibited: false };
}
