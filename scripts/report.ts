// Shared console output for the scripts that finish by classifying the db. This block was three
// verbatim copies — in extract.ts, sync.ts and build.ts — which is how the empty-category warning
// came to be missing from all of them at once.
import type { DlcReport } from '../src/extract/dlc.js';

/**
 * A zero on the category signal is not a data point, it is a broken crawl: dlc_categories is empty,
 * so every page-level category check compared against an empty set. Warn rather than throw — the
 * other signals still classified the snapshot, and the report is worth reading either way.
 */
export function printDlcReport(report: DlcReport): void {
  console.log(`dlc: ${report.dlc}/${report.pages} pages, ${report.hasDlcSections} base pages mention DLC`);
  console.log(`signals: ${Object.entries(report.bySignal).map(([signal, hits]) => `${signal}=${hits}`).join(' ')}`);
  if (report.bySignal.category === 0) console.warn('warning: dlc_categories is empty, the category signal fired on nothing; run npm run sync-categories');
  if (report.ambiguous.length) console.log(`ambiguous (candidates for data/dlc-overrides.json): ${report.ambiguous.slice(0, 20).join(', ')}`);
}
