import { allSkillExampleTexts } from './example-import.js';

export const STOCK_DIAGNOSTIC_PROMPT =
  '请完成一个无外部副作用的自然语言测试任务，并清晰说明结论与依据。';

export function firstSkillExample(card) {
  return allSkillExampleTexts(card)[0] || '';
}

export function skillExampleChoices(card) {
  return allSkillExampleTexts(card);
}

export function promptForAgentCard(currentPrompt, card) {
  const current = String(currentPrompt ?? '');
  if (current !== STOCK_DIAGNOSTIC_PROMPT) return current;
  return firstSkillExample(card) || current;
}
