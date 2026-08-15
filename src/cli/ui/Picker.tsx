/**
 * Interactive session picker built from Ink primitives (`useInput` +
 * windowed list), replacing the old `@clack/prompts` select. Rendered to
 * stderr; requires a TTY on stdin and stderr.
 */

import { Box, Text, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useState } from 'react';

import type { SessionMeta } from '../../adapters/index.js';
import type { Session } from '../../model/session.js';
import { relativeAge, singleLine } from '../format.js';

export interface PickerEntry {
  meta: SessionMeta;
  /** Undefined when the transcript could not be parsed. */
  session: Session | undefined;
}

export interface PickerProps {
  entries: readonly PickerEntry[];
  /** Prefix each row with the source agent (multi-source pickers). */
  showAgent?: boolean;
  maxVisible?: number;
  onSubmit: (index: number) => void;
  onCancel: () => void;
}

export function Picker({
  entries,
  showAgent = false,
  maxVisible = 12,
  onSubmit,
  onCancel,
}: PickerProps): ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape || input === 'q') {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(cursor);
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(entries.length - 1, c + 1));
  });

  const windowStart = Math.max(
    0,
    Math.min(cursor - Math.floor(maxVisible / 2), entries.length - maxVisible),
  );
  const visible = entries.slice(windowStart, windowStart + maxVisible);
  const below = entries.length - windowStart - visible.length;

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Pick a session to evaluate </Text>
        <Text dimColor>(↑/↓ move · enter select · esc cancel)</Text>
      </Text>
      {windowStart > 0 && <Text dimColor>{`  ↑ ${windowStart} more`}</Text>}
      {visible.map((entry, i) => {
        const index = windowStart + i;
        const selected = index === cursor;
        const turnsLabel = entry.session ? `${entry.session.turns.length} turns` : 'unreadable';
        return (
          <Box key={entry.meta.id}>
            <Text {...(selected ? { color: 'cyan' as const } : {})}>
              {selected ? '❯ ' : '  '}
              {singleLine(entry.meta.title, 56)}
            </Text>
            <Text dimColor>
              {`  ${showAgent ? `${entry.meta.agent} · ` : ''}${entry.meta.project} · ` +
                `${relativeAge(entry.meta.updatedAt)} · ${turnsLabel}`}
            </Text>
          </Box>
        );
      })}
      {below > 0 && <Text dimColor>{`  ↓ ${below} more`}</Text>}
    </Box>
  );
}
