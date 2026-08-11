'use strict';
// Run: node --test plugins/podman-sandbox/broker/compose-validate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { validateComposeFile, BLOCKED_CAPS, parseMemBytes } = require('./compose-validate');

function parse(yaml) {
  return YAML.parse(yaml) || {};
}

// --- happy path ---

test('accepts a minimal valid compose file', () => {
  const doc = parse(`
services:
  web:
    image: nginx:alpine
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('accepts named volumes (no host path)', () => {
  const doc = parse(`
services:
  db:
    image: postgres:15
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('accepts safe cap_add like NET_BIND_SERVICE', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    cap_add:
      - NET_BIND_SERVICE
      - CHOWN
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('accepts empty doc / no services', () => {
  assert.deepEqual(validateComposeFile({}), { ok: true });
  assert.deepEqual(validateComposeFile(null), { ok: true });
});

// --- privileged ---

test('rejects privileged: true', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    privileged: true
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /privileged/);
});

test('allows privileged: false', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    privileged: false
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

// --- network_mode ---

test('rejects network_mode: host', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    network_mode: host
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /network_mode/);
});

test('allows network_mode: bridge', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    network_mode: bridge
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

// --- pid ---

test('rejects pid: host', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    pid: host
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /pid/);
});

// --- ipc ---

test('rejects ipc: host', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    ipc: host
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /ipc/);
});

// --- cap_add ---

test('rejects cap_add: [ALL]', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    cap_add:
      - ALL
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /cap_add/);
});

test('rejects cap_add: SYS_ADMIN', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    cap_add:
      - SYS_ADMIN
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /SYS_ADMIN/);
});

test('rejects cap_add: NET_ADMIN', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    cap_add: [NET_ADMIN]
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /NET_ADMIN/);
});

test('rejects cap_add: SYS_PTRACE', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    cap_add: [SYS_PTRACE]
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
});

test('rejects cap_add case-insensitively (sys_admin lower)', () => {
  const doc = { services: { app: { image: 'x', cap_add: ['sys_admin'] } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
});

test('BLOCKED_CAPS covers SYS_MODULE, SYS_RAW_IO, MKNOD', () => {
  for (const cap of ['SYS_MODULE', 'SYS_RAW_IO', 'MKNOD']) {
    const doc = { services: { app: { image: 'x', cap_add: [cap] } } };
    const r = validateComposeFile(doc);
    assert.equal(r.ok, false, `expected ${cap} to be blocked`);
  }
});

// --- volumes: host path bind mounts ---

test('rejects short-form absolute host path bind mount', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    volumes:
      - /:/mnt/host
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('rejects short-form Podman socket bind mount', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    volumes:
      - /var/run/podman/podman.sock:/var/run/docker.sock
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('rejects long-form bind mount (type: bind)', () => {
  const doc = {
    services: {
      app: {
        image: 'myapp',
        volumes: [{ type: 'bind', source: '/etc', target: '/host-etc' }],
      },
    },
  };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('allows long-form named volume (type: volume)', () => {
  const doc = {
    services: {
      app: {
        image: 'myapp',
        volumes: [{ type: 'volume', source: 'mydata', target: '/data' }],
      },
    },
  };
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('allows read-only named volume', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    volumes:
      - mydata:/data:ro
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

// --- devices ---

test('rejects devices passthrough', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    devices:
      - /dev/sda:/dev/sda
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /device/);
});

// --- adversarial composite: all dangerous fields at once ---

test('rejects a fully adversarial compose file, reports first violation', () => {
  const doc = parse(`
services:
  evil:
    image: alpine
    privileged: true
    network_mode: host
    pid: host
    cap_add: [ALL]
    volumes:
      - /:/mnt/host
    devices:
      - /dev/sda:/dev/sda
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  // Any of the blocked fields is sufficient — just confirm it's rejected.
});

// --- multi-service: bad service among good ones is still caught ---

test('catches a bad service in a multi-service file', () => {
  const doc = parse(`
services:
  web:
    image: nginx:alpine
  sidecar:
    image: alpine
    privileged: true
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /sidecar/);
  assert.match(r.error, /privileged/);
});

// --- bypass fixes: relative-path bind mounts ---

test('rejects relative path bind mount (./ prefix)', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    volumes:
      - ./secrets:/secrets
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('rejects path-traversal bind mount (../../ prefix)', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    volumes:
      - ../../../../etc:/etc
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('rejects long-form bind mount with relative source', () => {
  const doc = {
    services: {
      app: {
        image: 'myapp',
        volumes: [{ type: 'bind', source: '../data', target: '/data' }],
      },
    },
  };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

// --- bypass fixes: container:<name> namespace sharing ---

test('rejects network_mode: container:<name>', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    network_mode: container:vgh-claw-orchestrator
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /network_mode/);
});

test('rejects pid: container:<name>', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    pid: container:admin-console
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /pid/);
});

test('rejects ipc: container:<name>', () => {
  const doc = { services: { app: { image: 'x', ipc: 'container:conduwuit' } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /ipc/);
});

// --- bypass fixes: userns_mode and cgroup_parent ---

test('rejects userns_mode: host', () => {
  const doc = { services: { app: { image: 'x', userns_mode: 'host' } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /userns_mode/);
});

test('rejects cgroup_parent: host', () => {
  const doc = { services: { app: { image: 'x', cgroup_parent: 'host' } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /cgroup_parent/);
});

// --- bypass fix round 3: ~ prefix (live-confirmed) ---

test('rejects tilde home-dir bind mount (~/path)', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    volumes:
      - ~/../../etc:/etc_from_host:ro
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('rejects bare ~ as volume source', () => {
  const doc = { services: { app: { image: 'x', volumes: ['~:/home'] } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

// allowlist catches any future prefix variant not yet enumerated
test('rejects $HOME expansion syntax as volume source', () => {
  const doc = { services: { app: { image: 'x', volumes: ['$HOME/data:/data'] } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

test('rejects percent-encoded path as volume source', () => {
  const doc = { services: { app: { image: 'x', volumes: ['%7e/etc:/etc'] } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /host path bind/);
});

// --- security_opt: seccomp/apparmor unconfined (live-confirmed) ---

test('rejects security_opt: seccomp=unconfined', () => {
  const doc = parse(`
services:
  app:
    image: myapp
    security_opt:
      - seccomp=unconfined
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /security_opt/);
});

test('rejects security_opt: apparmor=unconfined', () => {
  const doc = { services: { app: { image: 'x', security_opt: ['apparmor=unconfined'] } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /security_opt/);
});

test('rejects security_opt: seccomp=unconfined case-insensitively', () => {
  const doc = { services: { app: { image: 'x', security_opt: ['Seccomp=Unconfined'] } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
});

test('allows security_opt: no-new-privileges=true', () => {
  const doc = { services: { app: { image: 'x', security_opt: ['no-new-privileges=true'] } } };
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

// --- bypass fix round 4: top-level volumes: external: true (live-confirmed) ---
// AST round 4: `external: true` + `name:` attaches to a pre-existing named
// volume by its GLOBAL name, bypassing projectFor()'s per-project
// auto-namespacing. Live-confirmed to mount the control-plane's own
// /workspace volume read-only into a scope-owned container.

test('rejects top-level volume with external: true', () => {
  const doc = parse(`
services:
  probe:
    image: alpine
    volumes:
      - pool:/mnt/pool:ro
volumes:
  pool:
    external: true
    name: vgh-claw_agent-pool-workspace
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
  assert.match(r.error, /pool/);
});

test('rejects top-level volume with external as an object (no name)', () => {
  const doc = {
    services: { probe: { image: 'alpine', volumes: ['data:/mnt/data'] } },
    volumes: { data: { external: { name: 'some-other-scope-volume' } } },
  };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
});

test('allows top-level named volume without external (auto-namespaced)', () => {
  const doc = parse(`
services:
  probe:
    image: alpine
    volumes:
      - pool:/mnt/pool:ro
volumes:
  pool: {}
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('allows top-level volume with external: false', () => {
  const doc = { services: { app: { image: 'x' } }, volumes: { data: { external: false } } };
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('rejects external volume even with no services (validated independently)', () => {
  const doc = { volumes: { pool: { external: true } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
});

test('rejects top-level network with external: true', () => {
  const doc = parse(`
services:
  probe:
    image: alpine
    networks: [shared]
networks:
  shared:
    external: true
    name: agent-studio_default
`);
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
  assert.match(r.error, /shared/);
});

test('rejects top-level network with external as an object (no name)', () => {
  const doc = {
    services: { probe: { image: 'alpine', networks: ['shared'] } },
    networks: { shared: { external: { name: 'some-other-scope-network' } } },
  };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
});

test('allows top-level named network without external (auto-namespaced)', () => {
  const doc = parse(`
services:
  probe:
    image: alpine
networks:
  default: {}
`);
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('allows top-level network with external: false', () => {
  const doc = { services: { app: { image: 'x' } }, networks: { default: { external: false } } };
  assert.deepEqual(validateComposeFile(doc), { ok: true });
});

test('rejects external network even with no services (validated independently)', () => {
  const doc = { networks: { shared: { external: true } } };
  const r = validateComposeFile(doc);
  assert.equal(r.ok, false);
  assert.match(r.error, /external/);
});

// --- B2: resource ceiling validation ---

// parseMemBytes helper
test('parseMemBytes: parses megabytes', () => {
  assert.equal(parseMemBytes('512m'), 512 * 1024 ** 2);
  assert.equal(parseMemBytes('512M'), 512 * 1024 ** 2);
});
test('parseMemBytes: parses gigabytes', () => {
  assert.equal(parseMemBytes('2g'), 2 * 1024 ** 3);
  assert.equal(parseMemBytes('1.5g'), 1.5 * 1024 ** 3);
});
test('parseMemBytes: returns null for unparseable input', () => {
  assert.equal(parseMemBytes(null), null);
  assert.equal(parseMemBytes('unlimited'), null);
});

// B2 ceiling enforcement — use env-var injection per test
test('B2: accepts memory within ceiling', () => {
  const prev = process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  process.env.PODMAN_MCP_MAX_MEM_LIMIT = '2g';
  try {
    // reload module to pick up new env var
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', deploy: { resources: { limits: { memory: '1g' } } } } } };
    assert.deepEqual(v(doc), { ok: true });
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_MEM_LIMIT;
    else process.env.PODMAN_MCP_MAX_MEM_LIMIT = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: rejects memory exceeding ceiling', () => {
  const prev = process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  process.env.PODMAN_MCP_MAX_MEM_LIMIT = '2g';
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', deploy: { resources: { limits: { memory: '8g' } } } } } };
    const r = v(doc);
    assert.equal(r.ok, false);
    assert.match(r.error, /memory limit 8g exceeds platform maximum/);
    assert.match(r.error, /PODMAN_MCP_MAX_MEM_LIMIT=2g/);
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_MEM_LIMIT;
    else process.env.PODMAN_MCP_MAX_MEM_LIMIT = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: rejects cpu count exceeding ceiling', () => {
  const prev = process.env.PODMAN_MCP_MAX_CPUS;
  process.env.PODMAN_MCP_MAX_CPUS = '4';
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', deploy: { resources: { limits: { cpus: 16 } } } } } };
    const r = v(doc);
    assert.equal(r.ok, false);
    assert.match(r.error, /cpu limit 16 exceeds platform maximum/);
    assert.match(r.error, /PODMAN_MCP_MAX_CPUS=4/);
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_CPUS;
    else process.env.PODMAN_MCP_MAX_CPUS = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: rejects memory exceeding ceiling via legacy v2 mem_limit key', () => {
  const prev = process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  process.env.PODMAN_MCP_MAX_MEM_LIMIT = '2g';
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', mem_limit: '8g' } } };
    const r = v(doc);
    assert.equal(r.ok, false);
    assert.match(r.error, /memory limit 8g exceeds platform maximum/);
    assert.match(r.error, /PODMAN_MCP_MAX_MEM_LIMIT=2g/);
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_MEM_LIMIT;
    else process.env.PODMAN_MCP_MAX_MEM_LIMIT = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: accepts legacy v2 mem_limit within ceiling', () => {
  const prev = process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  process.env.PODMAN_MCP_MAX_MEM_LIMIT = '2g';
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', mem_limit: '1g' } } };
    assert.deepEqual(v(doc), { ok: true });
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_MEM_LIMIT;
    else process.env.PODMAN_MCP_MAX_MEM_LIMIT = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: rejects cpu count exceeding ceiling via legacy v2 cpus key', () => {
  const prev = process.env.PODMAN_MCP_MAX_CPUS;
  process.env.PODMAN_MCP_MAX_CPUS = '4';
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', cpus: 16 } } };
    const r = v(doc);
    assert.equal(r.ok, false);
    assert.match(r.error, /cpu limit 16 exceeds platform maximum/);
    assert.match(r.error, /PODMAN_MCP_MAX_CPUS=4/);
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_CPUS;
    else process.env.PODMAN_MCP_MAX_CPUS = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: rejects when v2 key exceeds ceiling even if v3 value is within it', () => {
  const prev = process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  process.env.PODMAN_MCP_MAX_MEM_LIMIT = '2g';
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    // Both keys are checked independently — an over-ceiling v2 value can't be
    // masked by also setting a within-ceiling v3 value on the same service.
    const doc = {
      services: { app: { image: 'x', mem_limit: '8g', deploy: { resources: { limits: { memory: '1g' } } } } },
    };
    const r = v(doc);
    assert.equal(r.ok, false);
    assert.match(r.error, /memory limit 8g exceeds platform maximum/);
  } finally {
    if (prev == null) delete process.env.PODMAN_MCP_MAX_MEM_LIMIT;
    else process.env.PODMAN_MCP_MAX_MEM_LIMIT = prev;
    delete require.cache[require.resolve('./compose-validate')];
  }
});

test('B2: no ceiling when env vars unset — any limit accepted', () => {
  // Ensure env vars are not set
  const prevMem = process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  const prevCpu = process.env.PODMAN_MCP_MAX_CPUS;
  delete process.env.PODMAN_MCP_MAX_MEM_LIMIT;
  delete process.env.PODMAN_MCP_MAX_CPUS;
  try {
    delete require.cache[require.resolve('./compose-validate')];
    const { validateComposeFile: v } = require('./compose-validate');
    const doc = { services: { app: { image: 'x', deploy: { resources: { limits: { memory: '128g', cpus: 256 } } } } } };
    assert.deepEqual(v(doc), { ok: true });
  } finally {
    if (prevMem != null) process.env.PODMAN_MCP_MAX_MEM_LIMIT = prevMem;
    if (prevCpu != null) process.env.PODMAN_MCP_MAX_CPUS = prevCpu;
    delete require.cache[require.resolve('./compose-validate')];
  }
});
