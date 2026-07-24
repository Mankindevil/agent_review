export const STOCK_DIAGNOSTIC_PROMPT =
  '请完成一个无外部副作用的自然语言测试任务，并清晰说明结论与依据。';

export function firstSkillExample(card) {
  for (const skill of Array.isArray(card?.skills) ? card.skills : []) {
    for (const example of Array.isArray(skill?.examples) ? skill.examples : []) {
      if (typeof example === 'string' && example.trim()) {
        return example.trim();
      }
    }
  }
  return '';
}

export function promptForAgentCard(currentPrompt, card) {
  const current = String(currentPrompt ?? '');
  if (current !== STOCK_DIAGNOSTIC_PROMPT) return current;
  return firstSkillExample(card) || current;
}
