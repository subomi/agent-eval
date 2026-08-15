/**
 * Final-artifact rendering: mount the node once inside `<Static>` on
 * **stdout** and unmount immediately, so piping stdout stays clean while
 * progress/interaction lives on stderr. Ink writes `<Static>` output even
 * when stdout is not a TTY, so `agent-evals ... > file` works.
 */

import { Box, render, Static } from 'ink';
import type { ReactElement } from 'react';

export async function printArtifact(node: ReactElement): Promise<void> {
  const instance = render(
    <Static items={[node]}>
      {(item, index) => (
        <Box key={index} flexDirection="column">
          {item}
        </Box>
      )}
    </Static>,
    { stdout: process.stdout, patchConsole: false, exitOnCtrlC: false },
  );
  // Let the reconciler flush the static frame before tearing down.
  await new Promise<void>((resolve) => setImmediate(resolve));
  instance.unmount();
  await instance.waitUntilExit();
}
