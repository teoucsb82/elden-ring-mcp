import { findInfobox } from '../wikitext/infobox.js';
import { matchingSections, text } from './common.js';
import type { Extractor } from './types.js';

export interface QuestStep {
  step_ord: number;
  location: string | null;
  action: string;
  breaks_quest: string | null;
}

export const BREAK_PATTERN = /\b(fail(s|ed)? the quest(line)?|will fail|locks? (you )?out|locked out|cannot be completed|quest(line)? (will )?end|permanently (?:lost|lose|loses|missed|missable|unavailable|unobtainable|fail(?:s|ed)?|locked|unable|gone)|missable)\b/i;

/**
 * Parses "1. Location" items with nested "- action" bullets (Fandom "Questline progression").
 * Many pages instead write a flat numbered list where the item itself is the action and no location
 * is named; such an item keeps its own text as the action rather than being dropped.
 */
export function parseQuestSteps(markdown: string): QuestStep[] {
  const steps: (QuestStep & { nested: boolean })[] = [];
  for (const line of markdown.split('\n')) {
    const top = /^1\.\s+(.*)$/.exec(line);
    const nested = /^\s{2,}(?:-|1\.)\s+(.*)$/.exec(line);
    if (top) {
      steps.push({ step_ord: steps.length + 1, location: top[1].trim() || null, action: '', breaks_quest: null, nested: false });
    } else if (nested && steps.length) {
      const step = steps[steps.length - 1];
      step.nested = true;
      const sentence = nested[1].trim();
      if (BREAK_PATTERN.test(sentence)) step.breaks_quest = step.breaks_quest ? `${step.breaks_quest} ${sentence}` : sentence;
      else step.action = step.action ? `${step.action} ${sentence}` : sentence;
    }
  }
  return steps
    .map(({ nested, ...step }) => {
      if (nested || !step.location) return step;
      // Flat item: its text is the step, not a heading for bullets that never came. A step that only
      // warns still has to say what to do, so a breaker keeps the sentence in both fields.
      const sentence = step.location;
      return BREAK_PATTERN.test(sentence)
        ? { ...step, location: null, action: sentence, breaks_quest: sentence }
        : { ...step, location: null, action: sentence };
    })
    .filter((step) => step.action || step.breaks_quest)
    // Dropped items must not leave gaps: step_ord is what callers count and order by.
    .map((step, index) => ({ ...step, step_ord: index + 1 }));
}

/**
 * "Questline progression" and the variants the wiki actually uses: "Questline steps", "Quest",
 * "Quests", and "<NPC>'s Quest". "Quest items" must not match — it lists items, not steps.
 */
const QUEST_HEADING = /^(?:.*['’]s )?quest(?:line)?s?(?: (?:progression|steps|walkthrough))?$/i;

/** A heading that names the progression outranks a bare "Quests" section that only links to it. */
const EXPLICIT_HEADING = /\b(progression|steps|walkthrough)\b/i;

/** NPCs with questlines are not always "Infobox Character": Patches is a Boss, invaders are Enemies. */
const NPC_INFOBOXES = ['Infobox Character', 'Infobox Enemy', 'Infobox Boss'];

export const questExtractor: Extractor = {
  name: 'quest',
  matches: (page) => !!page.wikitext && findInfobox(page.wikitext, NPC_INFOBOXES) !== null,
  write(db, page) {
    // A page often carries a bare "Quests" stub that only links the questline, ahead of the section
    // with the real steps. Since a flat "#" list parses, the stub parses too, so rank rather than
    // take the first: an explicit progression/steps heading wins, then the longer questline.
    const candidates = matchingSections(db, page.id, QUEST_HEADING)
      .map((section) => ({ explicit: EXPLICIT_HEADING.test(section.heading), steps: parseQuestSteps(section.markdown) }))
      .filter((candidate) => candidate.steps.length > 0)
      .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.steps.length - a.steps.length);
    const steps = candidates[0]?.steps;
    if (!steps) return;
    const npc = text(findInfobox(page.wikitext!, NPC_INFOBOXES)!.params.title) ?? page.title;
    const insert = db.prepare('INSERT INTO quests (page_id, npc, step_ord, location, action, breaks_quest) VALUES (?, ?, ?, ?, ?, ?)');
    for (const step of steps) insert.run(page.id, npc, step.step_ord, step.location, step.action, step.breaks_quest);
  },
};
