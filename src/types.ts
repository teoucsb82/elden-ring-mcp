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
  /** Fextralife only: the page as fetched, kept in the local cache so parsers can re-run without a re-fetch. */
  html?: string | null;
  license: string;
}
