import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

import { extractContributors, encodeContributors } from './src/components/contributors.js';

// Contributors list (#1742), resolved at build time and embedded as
// import.meta.env.VITE_CONTRIBUTORS (base64 of a JSON string[]).
//
// Two build contexts, mirroring the GIT_COMMIT handling:
//   - Docker (`make build`): git is NOT in the build context (it's admin-console/,
//     not the repo root with .git). The Makefile resolves the raw `%aN\t%aE`
//     git-log lines on the host and passes them base64-encoded as the
//     GIT_CONTRIBUTORS build arg -> VITE_CONTRIBUTORS_RAW env; we decode + extract
//     here, so no git binary is needed inside the image.
//   - Host-direct (`npm run build`, dev, CI admin-console-build): no build arg is
//     set, so we run git ourselves from the repo.
// Any failure degrades to an empty list, so the About section simply hides (AC6).
function resolveContributors() {
  try {
    let rawLog = '';
    const passed = process.env.VITE_CONTRIBUTORS_RAW;
    if (passed) {
      rawLog = Buffer.from(passed, 'base64').toString('utf8');
    } else {
      rawLog = execSync('git log --format=%aN%x09%aE', {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
    return encodeContributors(extractContributors(rawLog));
  } catch {
    return '';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.ADMIN_PORT || '4000';

  return {
    plugins: [react()],
    define: {
      // Computed here (not a plain VITE_-prefixed env) so both the Docker and
      // host-direct build paths land on one embedded value.
      'import.meta.env.VITE_CONTRIBUTORS': JSON.stringify(resolveContributors()),
    },
    server: {
      proxy: {
        '/api': `http://localhost:${apiPort}`,
      },
    },
  };
});
