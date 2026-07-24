import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VALID_KEY = Buffer.alloc(32, 9).toString('base64');

function importServer(overrides, source = "await import('./server.js')") {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    source
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_FILE: path.join(tmpdir(), `startup-${process.pid}-${Math.random()}.json`),
      ...overrides
    }
  });
}

test('disabled startup ignores an empty or invalid evidence key', () => {
  for (const value of ['', 'not-a-key']) {
    const result = importServer({
      A2A_BLACK_BOX_V1_ENABLED: 'false',
      EVIDENCE_ENCRYPTION_KEY: value
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('enabled startup rejects a missing, malformed, or noncanonical evidence key', () => {
  for (const value of ['', 'not-a-key', VALID_KEY.replace(/=$/u, '')]) {
    const result = importServer({
      A2A_BLACK_BOX_V1_ENABLED: 'true',
      EVIDENCE_ENCRYPTION_KEY: value
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EVIDENCE_ENCRYPTION_KEY/u);
    assert.equal(result.stderr.includes(value || 'empty-key-sentinel'), false);
  }

  const evidenceRoot = path.join(
    tmpdir(),
    `startup-evidence-config-${process.pid}-${Math.random()}`
  );
  try {
    const valid = importServer({
      A2A_BLACK_BOX_V1_ENABLED: 'true',
      EVIDENCE_ENCRYPTION_KEY: VALID_KEY,
      EVIDENCE_ROOT: evidenceRoot
    });
    assert.equal(valid.status, 0, valid.stderr);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('enabled server wires the V2 runtime and applies separate create body limits', () => {
  const evidenceRoot = path.join(
    tmpdir(),
    `startup-evidence-api-${process.pid}-${Math.random()}`
  );
  const source = `
    const { evaluationStore, pipeline, server } = await import('./server.js');
    const card = {
      name: 'Startup Agent',
      description: 'startup integration fixture',
      supportedInterfaces: [{
        url: 'https://example.com/a2a',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0'
      }],
      skills: [{ id: 'startup', name: 'Startup', description: 'fixture' }]
    };
    const direct = await pipeline.create({
      schemaVersion: 2,
      agentCard: card,
      agentExamples: [{
        id: 'direct',
        name: 'Direct',
        turns: [{
          input: { parts: [{ type: 'text', text: 'ping' }] },
          acceptanceCriteria: []
        }]
      }]
    });
    if (!/^[A-Za-z0-9_-]{43}$/.test(direct.participantAccessToken)) {
      throw new Error('V2 pipeline was not wired');
    }
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    await pipeline.cancel(direct.evaluation.id);
    while (pipeline.activeRuns.has(direct.evaluation.id)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const cancelled = evaluationStore.get(direct.evaluation.id);
    await evaluationStore.mutate(
      cancelled.id,
      cancelled.revision,
      (record) => ({
        ...record,
        execution: {
          status: 'interrupted',
          stage: 'recovery',
          progress: record.execution.progress,
          interruptedAt: new Date().toISOString()
        }
      })
    );
    const resumeHeaders = {
      authorization: 'Bearer ' + direct.participantAccessToken,
      'content-type': 'application/json',
      'idempotency-key': 'startup-resume-key-00001'
    };
    const firstResume = await fetch(
      origin + '/api/evaluations/' + direct.evaluation.id + '/resume',
      { method: 'POST', headers: resumeHeaders, body: '{}' }
    );
    const firstResumeBody = await firstResume.text();
    const replayResume = await fetch(
      origin + '/api/evaluations/' + direct.evaluation.id + '/resume',
      { method: 'POST', headers: resumeHeaders, body: '{}' }
    );
    const replayResumeBody = await replayResume.text();
    const rejectedToken = await fetch(
      origin + '/api/evaluations/' + direct.evaluation.id + '/resume',
      {
        method: 'POST',
        headers: {
          ...resumeHeaders,
          authorization: 'Bearer ' + 'B'.repeat(43),
          'idempotency-key': 'startup-resume-key-00002'
        },
        body: '{}'
      }
    );
    const oversizedResume = await fetch(
      origin + '/api/evaluations/' + direct.evaluation.id + '/resume',
      {
        method: 'POST',
        headers: {
          ...resumeHeaders,
          'idempotency-key': 'startup-resume-key-00003'
        },
        body: JSON.stringify({ padding: 'x'.repeat(16 * 1024) })
      }
    );
    if (
      firstResume.status !== 202 ||
      replayResume.status !== 202 ||
      replayResumeBody !== firstResumeBody ||
      firstResumeBody.includes(direct.participantAccessToken) ||
      rejectedToken.status !== 401 ||
      oversizedResume.status !== 413
    ) {
      throw new Error('participant-authenticated resume replay failed');
    }
    const makeBody = (size) => JSON.stringify({
      schemaVersion: 2,
      agentCard: card,
      agentExamples: [{
        id: 'large',
        name: 'Large',
        turns: [{
          input: { parts: [{ type: 'text', text: 'x'.repeat(size) }] },
          acceptanceCriteria: []
        }]
      }]
    });
    const accepted = await fetch(origin + '/api/evaluations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: makeBody(1_050_000)
    });
    if (accepted.status !== 202) {
      throw new Error('valid V2 body above legacy limit returned ' + accepted.status);
    }
    const rejected = await fetch(origin + '/api/evaluations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: makeBody(3 * 1024 * 1024)
    });
    if (rejected.status !== 413) {
      throw new Error('oversized V2 body returned ' + rejected.status);
    }
    process.exit(0);
  `;
  try {
    const result = importServer({
      A2A_BLACK_BOX_V1_ENABLED: 'true',
      EVIDENCE_ENCRYPTION_KEY: VALID_KEY,
      EVIDENCE_ROOT: evidenceRoot
    }, source);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
