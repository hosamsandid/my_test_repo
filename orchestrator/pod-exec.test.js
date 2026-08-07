'use strict';

// Unit tests for pod-exec.js's pure helpers — the hand-rolled WebSocket frame
// codec, the k8s exec-status → exit-code mapping, and the exec URL / upload
// command builders. The socket-level flow is covered by the kind e2e journey
// (context-mount.yaml); these tests pin the byte-level pieces that would fail
// silently against a real apiserver.
// Run: node --test orchestrator/pod-exec.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal, ContainerExecError } = require('./pod-exec');

const { buildExecPath, encodeFrame, FrameParser, parseExecStatus, buildUploadArgv } = _internal;

function collectParser() {
  const messages = [];
  const controls = [];
  const parser = new FrameParser(
    (opcode, payload) => messages.push({ opcode, payload }),
    (opcode, payload) => controls.push({ opcode, payload }),
  );
  return { parser, messages, controls };
}

test('buildExecPath encodes namespace, pod, container and each argv element', () => {
  const p = buildExecPath('agent-studio', 'aee-agent-a1-x', ['python3', '-c', 'print("a b")'], { stdin: false });
  assert.ok(p.startsWith('/api/v1/namespaces/agent-studio/pods/aee-agent-a1-x/exec?'));
  assert.ok(p.includes('container=as-agent'));
  assert.ok(p.includes('stdout=true'));
  assert.ok(p.includes('stderr=true'));
  assert.ok(p.includes('stdin=false'));
  assert.ok(p.includes('tty=false'));
  assert.ok(p.includes('command=python3'));
  assert.ok(p.includes(`command=${encodeURIComponent('print("a b")')}`));
});

test('buildExecPath flips stdin=true for the upload path', () => {
  assert.ok(buildExecPath('ns', 'p', ['sh'], { stdin: true }).includes('stdin=true'));
});

test('encodeFrame roundtrips through FrameParser for all payload size classes', () => {
  // Masked client frames must decode identically — the parser unmasks, so a
  // masked-encode → parse roundtrip proves both directions of the codec.
  for (const size of [0, 1, 125, 126, 65535, 65536, 200000]) {
    const payload = Buffer.alloc(size, 0xab);
    const { parser, messages } = collectParser();
    parser.push(encodeFrame(0x2, payload, true));
    assert.equal(messages.length, 1, `size ${size}`);
    assert.equal(messages[0].opcode, 0x2);
    assert.deepEqual(messages[0].payload, payload);
  }
});

test('FrameParser handles unmasked (server-style) frames and byte-dribbled input', () => {
  const payload = Buffer.concat([Buffer.from([1]), Buffer.from('hello stdout')]);
  const frame = encodeFrame(0x2, payload, false);
  const { parser, messages } = collectParser();
  for (const byte of frame) parser.push(Buffer.from([byte])); // worst-case TCP fragmentation
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].payload, payload);
});

test('FrameParser reassembles fragmented messages — channel byte once per message', () => {
  // First fragment carries opcode+channel; continuation carries data only.
  const first = encodeFrame(0x2, Buffer.from([1, 0x61]), false);
  first[0] &= 0x7f; // clear FIN
  const cont = encodeFrame(0x0, Buffer.from('bc'), false);
  const { parser, messages } = collectParser();
  parser.push(Buffer.concat([first, cont]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].payload, Buffer.from([1, 0x61, 0x62, 0x63]));
});

test('FrameParser routes control frames interleaved between fragments', () => {
  const first = encodeFrame(0x2, Buffer.from([2, 0x65]), false);
  first[0] &= 0x7f;
  const ping = encodeFrame(0x9, Buffer.from('k'), false);
  const cont = encodeFrame(0x0, Buffer.from('rr'), false);
  const { parser, messages, controls } = collectParser();
  parser.push(Buffer.concat([first, ping, cont]));
  assert.equal(controls.length, 1);
  assert.equal(controls[0].opcode, 0x9);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].payload, Buffer.from([2, 0x65, 0x72, 0x72]));
});

test('FrameParser emits multiple back-to-back messages from one chunk', () => {
  const a = encodeFrame(0x2, Buffer.from([1, 0x31]), false);
  const b = encodeFrame(0x2, Buffer.from([2, 0x32]), false);
  const { parser, messages } = collectParser();
  parser.push(Buffer.concat([a, b]));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].payload[0], 1);
  assert.equal(messages[1].payload[0], 2);
});

test('parseExecStatus maps Success, NonZeroExitCode and hard failures', () => {
  assert.deepEqual(parseExecStatus('{"status":"Success"}'), { ok: true, exitCode: 0 });
  assert.deepEqual(parseExecStatus(JSON.stringify({
    status: 'Failure',
    reason: 'NonZeroExitCode',
    details: { causes: [{ reason: 'ExitCode', message: '7' }] },
  })), { ok: true, exitCode: 7 });
  // NonZeroExitCode without a parsable cause still reports failure honestly.
  assert.deepEqual(parseExecStatus('{"status":"Failure","reason":"NonZeroExitCode"}'), { ok: true, exitCode: 1 });
  const gone = parseExecStatus('{"status":"Failure","message":"container not found"}');
  assert.equal(gone.ok, false);
  assert.equal(gone.message, 'container not found');
  assert.equal(parseExecStatus('not json').ok, false);
  assert.equal(parseExecStatus('').ok, false);
});

test('buildUploadArgv bounds stdin with head -c and keeps the path out of the shell string', () => {
  const argv = buildUploadArgv(1024, '/context/out');
  assert.deepEqual(argv, ['sh', '-c', 'head -c 1024 | tar -xf - -C "$1"', 'sh', '/context/out']);
  // A hostile-looking path never reaches the -c string itself.
  const evil = buildUploadArgv(1, '/context/$(reboot)');
  assert.equal(evil[2], 'head -c 1 | tar -xf - -C "$1"');
  assert.equal(evil[4], '/context/$(reboot)');
  assert.throws(() => buildUploadArgv(1.5, '/x'), (e) => e instanceof ContainerExecError && e.code === 'bad-argv');
  assert.throws(() => buildUploadArgv(-1, '/x'), (e) => e.code === 'bad-argv');
});
