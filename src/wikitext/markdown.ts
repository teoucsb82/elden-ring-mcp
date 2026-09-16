/**
 * Stands in for </tabber> between the tag sweep and the line pass. Printable on purpose: a
 * control-character sentinel makes this file binary to git and is silently stripped by tools
 * that sanitise input, which would disable the tab boundary without any error.
 */
const END_TABBER = '@@TABBER_END_8f2b6d41a7c94e03@@';

/** Removes every {{...}} template, including nested ones. */
export function stripTemplates(text: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '{{') { depth++; i++; continue; }
    if (two === '}}' && depth > 0) { depth--; i++; continue; }
    if (depth === 0) out += text[i];
  }
  return out;
}

/**
 * Fandom spells the products through templates rather than writing them out, so stripTemplates
 * deleted the name itself: "is an Arrow in {{ER}}." became "is an Arrow in ." and a lead opening
 * with '''{{PAGENAME}}''' became "****". Keys are the template name lowercased with all whitespace
 * removed, so "{{ in | se }}" and "{{IN|SE}}" both resolve.
 */
const PRODUCT_NAMES: Record<string, string> = {
  er: 'Elden Ring',
  sote: 'Shadow of the Erdtree',
  ern: 'Elden Ring Nightreign',
  'in|er': 'in Elden Ring',
  'in|se': 'in Shadow of the Erdtree',
  'in|sote': 'in Shadow of the Erdtree',
  'in|ern': 'in Elden Ring Nightreign',
};

/**
 * Replaces only the product-name templates and {{PAGENAME}} with their text. Deliberately anchored
 * on the whole {{...}} so it cannot reach inside {{Infobox ...}}, {{quote}} or any other template
 * that still has to be stripped whole.
 */
function substituteProductNames(text: string, title: string): string {
  return text.replace(/\{\{\s*(PAGENAME|ERN?|SotE|in\s*\|\s*(?:er|se|sote|ern))\s*\}\}/gi, (match, name: string) => {
    const key = name.toLowerCase().replace(/\s+/g, '');
    if (key === 'pagename') return title;
    return PRODUCT_NAMES[key] ?? match;
  });
}

/** Removes {| ... |} tables line by line (nesting-aware). */
function stripTables(text: string): string {
  let depth = 0;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('{|')) { depth++; continue; }
    if (trimmed.startsWith('|}') && depth > 0) { depth--; continue; }
    if (depth === 0) kept.push(line);
  }
  return kept.join('\n');
}

export function convertInline(text: string): string {
  return text
    .replace(/\[\[(?:File|Image|Category|[a-z]{2,3}(?:-[a-z]+)?):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/'''(.*?)'''/g, '**$1**')
    .replace(/''(.*?)''/g, '*$1*')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:small|span|div|center|big|sup|sub|u|s|i|b|nowiki|p)\b[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ');
}

/** `title` fills {{PAGENAME}}; callers without one get the empty string, as MediaWiki would. */
export function wikitextToMarkdown(wikitext: string, title = ''): string {
  let text = substituteProductNames(wikitext.replace(/<!--[\s\S]*?-->/g, ''), title);
  text = text.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/<gallery[\s\S]*?<\/gallery>/gi, '');
  // The opening tag carries no content, but the closing tag ends the tabbed region: prose after it
  // belongs to the enclosing section, not to the last tab. Keep it as a marker to act on below.
  // Drop any pre-existing copy of the sentinel so page text cannot fake a tab boundary.
  text = text.split(END_TABBER).join('');
  text = text.replace(/<tabber\b[^>]*>/gi, '').replace(/<\/tabber\s*>/gi, `\n${END_TABBER}\n`);
  text = stripTables(stripTemplates(text));
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Some pages break a tab label onto its own line ("|-|\nArtist's Shack ="); rejoin before parsing.
  text = text.replace(/^\|-\|[ \t]*\r?\n[ \t]*(?=[^\n]*=[ \t]*$)/gm, '|-|');
  let enclosing = '';
  const lines = text.split('\n').map((line) => {
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (heading) {
      enclosing = `${'#'.repeat(heading[1].length)} ${heading[2]}`;
      return enclosing;
    }
    // Fandom <tabber> tab label: the whole line is "|-|Label=". Its content follows, so make it a
    // heading rather than leaving the scaffolding in the prose.
    const tab = /^\|-\|\s*(.+?)\s*=\s*$/.exec(line);
    if (tab) return `## ${tab[1]}`;
    // Closing the tabber reopens the enclosing section, so trailing prose is not read as a tab's.
    if (line.trim() === END_TABBER) return enclosing;
    const list = /^([*#]+)\s*(.*)$/.exec(line);
    if (list) return `${'  '.repeat(list[1].length - 1)}${list[1].endsWith('#') ? '1.' : '-'} ${list[2].trim()}`;
    return line.trimEnd();
  });
  return convertInline(lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
}

/** Single-line plain text for infobox values. */
export function plainText(value: string): string {
  return convertInline(stripTemplates(value.replace(/<!--[\s\S]*?-->/g, '')))
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
