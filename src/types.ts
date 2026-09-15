export type SourceId = 'fandom' | 'fextralife';

/** One wiki page as fetched. Fandom supplies wikitext; Fextralife supplies markdown. */
export interface RawPage {
  source: SourceId;
  title: string;
  url: string;
  revid: number | null;
  fetchedAt: string;
  wikitext: string | null;
  markdown: string | null;
  license: string;
}
