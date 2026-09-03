/**
 * Parallel dev runner — starts API + Worker + Web frontend side by side.
 *
 * Usage: `npm run dev` (from the monorepo root)
 *
 * Each process gets a prefix and colour so their logs are distinguishable in a
 * single terminal. Ctrl-C kills all.
 */

import { spawn } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const processes = [
  { name: 'api', color: '\x1b[36m', cmd: npmCmd, args: ['run', 'dev:api'] },
  { name: 'worker', color: '\x1b[33m', cmd: npmCmd, args: ['run', 'dev:worker'] },
  { name: 'web', color: '\x1b[35m', cmd: npmCmd, args: ['run', 'dev:web'] },
];

const reset = '\x1b[0m';

for (const proc of processes) {
  const child = spawn(proc.cmd, proc.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const prefix = `${proc.color}[${proc.name}]${reset} `;

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) process.stderr.write(`${prefix}${line}\n`);
    }
  });

  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
  });
}

// Forward Ctrl-C to children
process.on('SIGINT', () => {
  process.exit(0);
});
