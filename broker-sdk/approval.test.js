'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsApproval, approvalHoldingPen, parkForApproval } = require('./approval');

test('needsApproval: empty/absent list gates nothing', () => {
  assert.equal(needsApproval('container_exec', []), false);
  assert.equal(needsApproval('container_exec', undefined), false);
});

test('needsApproval: only listed subcommands are gated', () => {
  assert.equal(needsApproval('container_exec', ['container_exec']), true);
  assert.equal(needsApproval('compose_up', ['container_exec']), false);
});

test('holding pen: parks, then an approve returns the op to run', () => {
  const pen = approvalHoldingPen({ requiresApproval: ['container_exec'] });
  assert.equal(pen.needsApproval('container_exec'), true);
  const op = { id: 'dm-1', subcommand: 'container_exec', args: { name: 'x', cmd: ['ls'] } };
  const ticket = pen.park(op);
  assert.equal(ticket.status, 'pending');
  assert.equal(pen.pending().length, 1);
  assert.deepEqual(pen.resolve('dm-1', true), op); // approved → run it
  assert.equal(pen.pending().length, 0);
});

test('holding pen: a denial returns null and clears the ticket', () => {
  const pen = approvalHoldingPen({ requiresApproval: ['container_exec'] });
  pen.park({ id: 'dm-2', subcommand: 'container_exec' });
  assert.equal(pen.resolve('dm-2', false), null);
  assert.equal(pen.pending().length, 0);
});

test('holding pen: resolving an unknown/already-resolved id returns null', () => {
  const pen = approvalHoldingPen({ requiresApproval: ['x'] });
  assert.equal(pen.resolve('nope', true), null);
  pen.park({ id: 'dm-3', subcommand: 'x' });
  pen.resolve('dm-3', true);
  assert.equal(pen.resolve('dm-3', true), null); // no double-run
});

test('park requires an op with a string id', () => {
  const pen = approvalHoldingPen({ requiresApproval: ['x'] });
  assert.throws(() => pen.park({ subcommand: 'x' }), /string id/);
});

test('parkForApproval convenience returns a pending ticket', () => {
  const ticket = parkForApproval({ id: 'dm-9', subcommand: 'container_exec' });
  assert.equal(ticket.status, 'pending');
  assert.equal(ticket.id, 'dm-9');
});
