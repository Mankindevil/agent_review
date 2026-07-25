/**
 * Shared helpers for importing Agent usage examples into the V2 editor
 * and diagnostic prompt pickers.
 */

export function skillExamplesFromCard(card) {
  const drafts = [];
  const skills = Array.isArray(card?.skills) ? card.skills : [];
  for (const skill of skills) {
    const skillName = typeof skill?.name === 'string' && skill.name.trim()
      ? skill.name.trim()
      : typeof skill?.id === 'string' && skill.id.trim()
        ? skill.id.trim()
        : 'Skill';
    const examples = Array.isArray(skill?.examples) ? skill.examples : [];
    examples.forEach((example, index) => {
      if (typeof example !== 'string' || !example.trim()) return;
      const ordinal = drafts.length + 1;
      drafts.push({
        id: `example-${ordinal}`,
        name: examples.length > 1 ? `${skillName} ${index + 1}` : skillName,
        turns: [{
          parts: [{ type: 'text', text: example.trim() }],
          criteria: []
        }]
      });
    });
  }
  return drafts;
}

export function allSkillExampleTexts(card) {
  return skillExamplesFromCard(card).map((draft) => draft.turns[0].parts[0].text);
}

/**
 * Parse pasted markdown that looks like:
 *   ### 示例 1：标题
 *   **输入**
 *   ```json
 *   {"text":"..."}
 *   ```
 *   **预期输出要点**
 *   - point
 */
export function parseExampleMarkdown(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { drafts: [], errors: ['粘贴内容为空'] };

  const sections = splitExampleSections(text);
  if (!sections.length) {
    return {
      drafts: [],
      errors: ['未识别到「### 示例」段落；请按「### 示例 N：标题」分段']
    };
  }

  const drafts = [];
  const errors = [];
  sections.forEach((section, index) => {
    try {
      drafts.push(parseOneExampleSection(section, index + 1));
    } catch (error) {
      errors.push(`示例 ${index + 1}：${error.message || error}`);
    }
  });

  if (!drafts.length && !errors.length) {
    errors.push('未能解析出任何可用示例');
  }
  return { drafts, errors };
}

function splitExampleSections(text) {
  const heading = /^(#{2,3})\s*示例\s*(\d+)\s*[：:．.\-—]?\s*(.*)$/gm;
  const matches = [...text.matchAll(heading)];
  if (!matches.length) return [];
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return {
      ordinal: Number(match[2]) || index + 1,
      title: String(match[3] || '').trim(),
      body: text.slice(start + match[0].length, end).trim()
    };
  });
}

function parseOneExampleSection(section, fallbackOrdinal) {
  const ordinal = section.ordinal || fallbackOrdinal;
  const name = section.title || `公开研究任务 ${ordinal}`;
  const input = extractInputPayload(section.body);
  if (!input.text && !input.data) {
    throw new Error('缺少「输入」文本或 JSON');
  }

  const bullets = extractExpectedBullets(section.body);
  const parts = [];
  if (input.text) {
    parts.push({ type: 'text', text: input.text });
  }
  if (input.data) {
    parts.push({
      type: 'data',
      text: JSON.stringify(input.data, null, 2),
      mediaType: 'application/json'
    });
  }

  const criteria = [];
  if (bullets.length) {
    criteria.push({
      id: `criterion-${ordinal}`,
      type: 'contains',
      description: '预期输出要点',
      expected: bullets,
      required: false
    });
  }

  return {
    id: `example-${ordinal}`,
    name,
    turns: [{
      expectedDeliverable: bullets.length
        ? '按预期输出要点完成可解释投研交付'
        : '',
      parts,
      criteria
    }]
  };
}

function extractInputPayload(body) {
  const labeled = body.match(
    /\*\*输入\*\*\s*([\s\S]*?)(?=\n\*\*[^*\n]+\*\*|\n#{2,3}\s|$)/u
  );
  const region = labeled ? labeled[1] : body;
  const fenced = [...region.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)];
  for (const fence of fenced) {
    const candidate = fence[1].trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        const rest = { ...parsed };
        delete rest.text;
        const hasExtra = Object.keys(rest).length > 0;
        return {
          text: text || (hasExtra ? '' : candidate),
          data: hasExtra ? parsed : null
        };
      }
    } catch {
      return { text: candidate, data: null };
    }
    return { text: candidate, data: null };
  }

  const plain = region
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('**') && !line.startsWith('#'))
    .join('\n')
    .trim();
  return { text: plain, data: null };
}

function extractExpectedBullets(body) {
  const labeled = body.match(
    /\*\*预期输出要点\*\*\s*([\s\S]*?)(?=\n\*\*[^*\n]+\*\*|\n#{2,3}\s|$)/u
  );
  if (!labeled) return [];
  return labeled[1]
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);
}
