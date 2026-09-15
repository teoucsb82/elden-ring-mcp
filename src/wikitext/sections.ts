export interface Section {
  ord: number;
  heading: string;
  markdown: string;
}

/** Splits markdown on headings; empty sections are dropped; lead text is "Summary". */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let heading = 'Summary';
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ ord: sections.length, heading, markdown: body });
    buffer = [];
  };
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) { flush(); heading = match[1].trim(); continue; }
    buffer.push(line);
  }
  flush();
  return sections;
}
