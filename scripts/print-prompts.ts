/**
 * Phase-2B verification script (no LLM calls, no canned judge responses).
 *
 * Builds a realistic sample coding-agent session, runs every metric against a
 * prompt-capturing judge that records the prompt and aborts (it never
 * fabricates a response), and prints each metric's full judge prompt for
 * inspection. Also checks the tool-efficiency short-circuit for sessions
 * without tool calls, and reports whether any provider API key is present.
 *
 * Run: pnpm tsx scripts/print-prompts.ts
 */

import { allMetrics } from '../src/metrics/index.js';
import type { Judge, JudgeInput } from '../src/judge/types.js';
import type { Session } from '../src/model/session.js';

/** Records the prompt, then aborts the evaluation. Never returns a response. */
class PromptCaptureJudge implements Judge {
  prompts: string[] = [];
  evaluate<T>(input: JudgeInput<T>): Promise<T> {
    this.prompts.push(input.prompt);
    return Promise.reject(new CaptureDone());
  }
}

class CaptureDone extends Error {
  constructor() {
    super('prompt captured; evaluation intentionally aborted');
  }
}

const sampleSession: Session = {
  id: 'sample-session',
  agent: 'cursor',
  project: 'acme-web',
  title: 'Fix login redirect bug',
  updatedAt: new Date('2026-08-14T12:00:00Z'),
  turns: [
    {
      index: 1,
      role: 'user',
      text: "The login page redirects to /home even when ?next= is set. Fix it in src/auth/redirect.ts. Don't touch the signup flow. Done means `pnpm test` passes.",
      toolCalls: [],
    },
    {
      index: 2,
      role: 'assistant',
      text: 'Let me look at the redirect logic first.',
      toolCalls: [
        { name: 'Read', input: { path: 'src/auth/redirect.ts' }, result: 'export function afterLogin() { return "/home"; }' },
        { name: 'Grep', input: { pattern: 'next=', path: 'src' }, result: 'src/auth/login.ts:12: const next = params.get("next")' },
      ],
    },
    {
      index: 3,
      role: 'assistant',
      text: 'The ?next= param is parsed but never used. Fixing and running tests.',
      toolCalls: [
        { name: 'Edit', input: { path: 'src/auth/redirect.ts', diff: '+ return next ?? "/home";' } },
        { name: 'Shell', input: { command: 'pnpm test' }, result: '1 failing: redirect honors next param', isError: true },
      ],
    },
    {
      index: 4,
      role: 'assistant',
      text: 'One test still failing; re-reading the file to check my edit.',
      toolCalls: [
        { name: 'Read', input: { path: 'src/auth/redirect.ts' }, result: 'export function afterLogin(next?: string) { return next ?? "/home"; }' },
        { name: 'Read', input: { path: 'src/auth/redirect.ts' }, result: 'export function afterLogin(next?: string) { return next ?? "/home"; }' },
        { name: 'Shell', input: { command: 'pnpm test' }, result: 'all tests passing' },
      ],
    },
    {
      index: 5,
      role: 'user',
      text: "Wait, you also changed src/signup/form.ts — I said don't touch the signup flow. Revert that part.",
      toolCalls: [],
    },
    {
      index: 6,
      role: 'assistant',
      text: 'You are right, reverting the signup change and re-running tests.',
      toolCalls: [
        { name: 'Shell', input: { command: 'git checkout -- src/signup/form.ts' }, result: '' },
        { name: 'Shell', input: { command: 'pnpm test' }, result: 'all tests passing' },
      ],
    },
    {
      index: 7,
      role: 'user',
      text: 'Great, thanks. That fixes it.',
      toolCalls: [],
    },
  ],
};

const noToolSession: Session = {
  ...sampleSession,
  id: 'no-tool-session',
  turns: [
    { index: 1, role: 'user', text: 'What does the redirect module do?', toolCalls: [] },
    { index: 2, role: 'assistant', text: 'It computes the post-login destination.', toolCalls: [] },
  ],
};

const KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
];

async function main(): Promise<void> {
  let failures = 0;

  for (const metric of allMetrics) {
    const judge = new PromptCaptureJudge();
    try {
      await metric.evaluate(sampleSession, judge);
      console.error(`ERROR: ${metric.id} completed without consulting the judge on a tool-using session`);
      failures += 1;
      continue;
    } catch (error) {
      if (!(error instanceof CaptureDone)) throw error;
    }
    const prompt = judge.prompts[0];
    if (prompt === undefined) {
      console.error(`ERROR: ${metric.id} did not build a prompt`);
      failures += 1;
      continue;
    }
    for (const required of ['[turn 1 | user]', '[turn 7 | user]', 'advice']) {
      if (!prompt.includes(required)) {
        console.error(`ERROR: ${metric.id} prompt is missing "${required}"`);
        failures += 1;
      }
    }
    const header = `${metric.name} (${metric.id} v${metric.version}, target: ${metric.target})`;
    console.log(`\n${'='.repeat(80)}\n${header} — prompt (${prompt.length} chars)\n${'='.repeat(80)}\n`);
    console.log(prompt);
  }

  // Deterministic short-circuit: no tool calls -> perfect score, no judge call.
  const shortCircuitJudge = new PromptCaptureJudge();
  const toolEfficiency = allMetrics.find((m) => m.id === 'tool-efficiency')!;
  const result = await toolEfficiency.evaluate(noToolSession, shortCircuitJudge);
  if (result.score !== 1 || shortCircuitJudge.prompts.length !== 0) {
    console.error('ERROR: tool-efficiency short-circuit did not behave as expected');
    failures += 1;
  } else {
    console.log(`\n${'='.repeat(80)}\ntool-efficiency short-circuit on a session without tool calls: OK (score 1, no judge call)`);
  }

  const presentKeys = KEY_ENV_VARS.filter((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0;
  });
  console.log(
    presentKeys.length > 0
      ? `\nProvider API keys present in env: ${presentKeys.join(', ')}`
      : '\nNo provider API keys present in env — live judge calls are not possible here.',
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${allMetrics.length} metrics built valid judge prompts. No LLM was called.`);
  }
}

await main();
