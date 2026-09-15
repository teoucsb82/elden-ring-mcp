export interface Infobox {
  template: string;
  params: Record<string, string>;
}

/** Exclusive end index of the template opening at `start` ("{{"), or -1 if unclosed. */
function closeOf(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; }
    else if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Splits template body on "|" outside [[...]] and {{...}}. */
function splitParams(body: string): string[] {
  const parts: string[] = [];
  let square = 0;
  let curly = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '[[' || two === ']]' || two === '{{' || two === '}}') {
      if (two === '[[') square++;
      if (two === ']]') square = Math.max(0, square - 1);
      if (two === '{{') curly++;
      if (two === '}}') curly = Math.max(0, curly - 1);
      current += two;
      i++;
      continue;
    }
    if (body[i] === '|' && square === 0 && curly === 0) { parts.push(current); current = ''; continue; }
    current += body[i];
  }
  parts.push(current);
  return parts;
}

const normalizeName = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** First template on the page whose name is one of `names` (case/underscore-insensitive). */
export function findInfobox(wikitext: string, names: string[]): Infobox | null {
  const wanted = new Set(names.map(normalizeName));
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, '');
  const opener = /\{\{\s*([^|}\n]+)/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    if (!wanted.has(normalizeName(match[1]))) continue;
    const end = closeOf(text, match.index);
    if (end < 0) return null;
    const [, ...rawParams] = splitParams(text.slice(match.index + 2, end - 2));
    const params: Record<string, string> = {};
    for (const raw of rawParams) {
      const eq = raw.indexOf('=');
      if (eq >= 0) params[raw.slice(0, eq).trim().toLowerCase()] = raw.slice(eq + 1).trim();
    }
    return { template: match[1].trim(), params };
  }
  return null;
}
