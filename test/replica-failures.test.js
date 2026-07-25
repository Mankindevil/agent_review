import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReplicaFailure } from '../src/replica-failures.js';

test('invalidates a replica for failed health, sandbox startup, transport, and storage failures', () => {
  for (const code of ['HEALTH_FAILED', 'SANDBOX_STARTUP_FAILED', 'ADAPTER_TRANSPORT_FAILED', 'PLATFORM_STORAGE_FAILED']) {
    assert.deepEqual(classifyReplicaFailure({ code, message: code }, { ready: false }), {
      source: 'replica-infrastructure', code, scoreSemantics: 'invalidate-replica'
    });
  }
});

test('scores zero only after a valid Skill execution boundary times out, crashes, or returns invalid output', () => {
  for (const code of ['TIMEOUT', 'SKILL_CRASH', 'INVALID_REPLICA_OUTPUT', 'NETWORK_DENIED']) {
    assert.deepEqual(classifyReplicaFailure({ code, message: code }, { ready: true, executionStarted: true, artifactValid: true }), {
      source: 'replica-skill', code, scoreSemantics: 'score-zero'
    });
  }
});

test('holds ambiguous failures for review rather than declaring a submitted-Agent win', () => {
  assert.deepEqual(classifyReplicaFailure(new Error('unexpected disconnect'), { ready: true, artifactValid: true }), {
    source: 'unknown', code: 'UNKNOWN_REPLICA_FAILURE', scoreSemantics: 'hold-for-review'
  });
});

test('attributes run-boundary cap failures to the Skill but build and pre-boundary enforcement failures to infrastructure', () => {
  for (const code of ['REPLICA_WALL_CLOCK_EXCEEDED', 'REPLICA_OUTPUT_BYTES_EXCEEDED', 'REPLICA_TOKEN_CAP_EXCEEDED', 'NETWORK_DENIED']) {
    assert.deepEqual(classifyReplicaFailure({ code }, { ready: true, artifactValid: true, executionStarted: true }), {
      source: 'replica-skill', code, scoreSemantics: 'score-zero'
    });
    assert.deepEqual(classifyReplicaFailure({ code }, { ready: true, artifactValid: true, executionStarted: false }), {
      source: 'replica-infrastructure', code, scoreSemantics: 'invalidate-replica'
    });
  }
  assert.deepEqual(classifyReplicaFailure({ code: 'REPLICA_ENFORCEMENT_UNPROVEN' }, { ready: false }), {
    source: 'replica-infrastructure', code: 'REPLICA_ENFORCEMENT_UNPROVEN', scoreSemantics: 'invalidate-replica'
  });
});

test('attributes timeout, crash, and invalid output to infrastructure until a valid execution boundary has started', () => {
  for (const code of ['TIMEOUT', 'SKILL_CRASH', 'INVALID_REPLICA_OUTPUT']) {
    assert.deepEqual(classifyReplicaFailure({ code }, { ready: true, artifactValid: true, executionStarted: false }), {
      source: 'replica-infrastructure', code, scoreSemantics: 'invalidate-replica'
    });
  }
});
