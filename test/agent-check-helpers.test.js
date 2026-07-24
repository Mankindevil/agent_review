import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_DIAGNOSTIC_PROMPT,
  firstSkillExample,
  promptForAgentCard
} from '../public/agent-check-helpers.js';

test('selects the first non-empty skill example', () => {
  const card = {
    skills: [
      { examples: [null, '   '] },
      { examples: ['  run the declared market report  ', 'later'] }
    ]
  };

  assert.equal(firstSkillExample(card), 'run the declared market report');
});

test('replaces only the untouched stock diagnostics prompt', () => {
  const card = {
    skills: [{ examples: ['run the declared operation'] }]
  };

  assert.equal(
    promptForAgentCard(STOCK_DIAGNOSTIC_PROMPT, card),
    'run the declared operation'
  );
  assert.equal(
    promptForAgentCard('my custom task', card),
    'my custom task'
  );
  assert.equal(
    promptForAgentCard(STOCK_DIAGNOSTIC_PROMPT, { skills: [] }),
    STOCK_DIAGNOSTIC_PROMPT
  );
});
