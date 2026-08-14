#!/usr/bin/env node
/**
 * `agent-evals` bin entry. Kept tiny on purpose: it must patch
 * `process.emitWarning` (to silence the node:sqlite ExperimentalWarning) and
 * load `.env.local`/`.env` BEFORE the rest of the app is evaluated — static
 * imports would hoist module evaluation (and the sqlite import) above any
 * code here, so the real flow is pulled in with dynamic imports.
 */

suppressExperimentalWarnings();

const { loadDotEnv } = await import('./env.js');
loadDotEnv();

const { main } = await import('./main.js');
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`agent-evals: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function suppressExperimentalWarnings(): void {
  const original = process.emitWarning.bind(process) as (
    warning: string | Error,
    ...rest: unknown[]
  ) => void;

  const warningName = (warning: string | Error, options: unknown): string | undefined => {
    if (typeof options === 'string') return options;
    if (options !== null && typeof options === 'object') {
      const type = (options as { type?: unknown }).type;
      if (typeof type === 'string') return type;
    }
    return warning instanceof Error ? warning.name : undefined;
  };

  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    if (warningName(warning, rest[0]) === 'ExperimentalWarning') return;
    original(warning, ...rest);
  }) as typeof process.emitWarning;
}
