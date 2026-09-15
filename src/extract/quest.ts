import { findInfobox } from '../wikitext/infobox.js';
import { sectionMarkdown, text } from './common.js';
import type { Extractor } from './types.js';

export interface QuestStep {
  step_ord: number;
  location: string | null;
  action: string;
  breaks_quest: string | null;
}

export const BREAK_PATTERN = /\b(fail(s|ed)? the quest(line)?|will fail|locks? (you )?out|locked out|cannot be completed|quest(line)? (will )?end|permanently (?:lost|lose|loses|missed|missable|unavailable|unobtainable|fail(?:s|ed)?|locked|unable|gone)|missable)\b/i;

/** Parses "1. Location" items with nested "- action" bullets (Fandom "Questline progression"). */
export function parseQuestSteps(markdown: string): QuestStep[] {
  const steps: QuestStep[] = [];
  for (const line of markdown.split('\n')) {
    const top = /^1\.\s+(.*)$/.exec(line);
    const nested = /^\s{2,}(?:-|1\.)\s+(.*)$/.exec(line);
    if (top) {
      steps.push({ step_ord: steps.length + 1, location: top[1].trim() || null, action: '', breaks_quest: null });
    } else if (nested && steps.length) {
      const step = steps[steps.length - 1];
      const sentence = nested[1].trim();
      if (BREAK_PATTERN.test(sentence)) step.breaks_quest = step.breaks_quest ? `${step.breaks_quest} ${sentence}` : sentence;
      else step.action = step.action ? `${step.action} ${sentence}` : sentence;
    }
  }
  return steps.filter((step) => step.action || step.breaks_quest);
}

const QUEST_HEADING = /^(questline progression|quest progression|quest walkthrough|questline)$/i;

export const questExtractor: Extractor = {
  name: 'quest',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, ['Infobox Character']) !== null,
  write(db, page) {
    const markdown = sectionMarkdown(db, page.id, QUEST_HEADING);
    if (!markdown) return;
    const npc = text(findInfobox(page.wikitext!, ['Infobox Character'])!.params.title) ?? page.title;
    const insert = db.prepare('INSERT INTO quests (page_id, npc, step_ord, location, action, breaks_quest) VALUES (?, ?, ?, ?, ?, ?)');
    for (const step of parseQuestSteps(markdown)) insert.run(page.id, npc, step.step_ord, step.location, step.action, step.breaks_quest);
  },
};
