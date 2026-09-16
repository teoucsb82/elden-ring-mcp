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
    .replace(/<\/?(?:small|span|div|center|big|sup|sub|u|s|nowiki|p)\b[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ');
}

export function wikitextToMarkdown(wikitext: string): string {
  let text = wikitext.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/<gallery[\s\S]*?<\/gallery>/gi, '');
  text = text.replace(/<\/?tabber\b[^>]*>/gi, '');
  text = stripTables(stripTemplates(text));
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Some pages break a tab label onto its own line ("|-|\nArtist's Shack ="); rejoin before parsing.
  text = text.replace(/^\|-\|[ \t]*\r?\n[ \t]*(?=[^\n]*=[ \t]*$)/gm, '|-|');
  const lines = text.split('\n').map((line) => {
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (heading) return `${'#'.repeat(heading[1].length)} ${heading[2]}`;
    // Fandom <tabber> tab label: the whole line is "|-|Label=". Its content follows, so make it a
    // heading rather than leaving the scaffolding in the prose.
    const tab = /^\|-\|\s*(.+?)\s*=\s*$/.exec(line);
    if (tab) return `## ${tab[1]}`;
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
