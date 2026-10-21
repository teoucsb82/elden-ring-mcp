// Synthetic pages in Fextralife's MediaWiki markup (2026-10). The structure mirrors the live site;
// every sentence is invented, because Fextralife content is never committed to this repo.

const row = (label: string, value = '') =>
  `<div class="er-build-row"><span class="er-build-label">${label}</span><strong class="er-build-val">${value ? `<p>${value} </p>` : ''}</strong></div>`;
const cell = (label: string, value = '') =>
  `<div class="er-build-cell"><span class="er-build-label">${label}</span><strong class="er-build-val">${value ? `<p>${value} </p>` : ''}</strong></div>`;
const a = (title: string, text = title) => `<a href="/${encodeURIComponent(title.replace(/ /g, '_'))}" title="${title.replace(/'/g, '&#39;')}">${text}</a>`;

const shell = (title: string, body: string) => `<!DOCTYPE html><html><head><title>${title} | Elden Ring Wiki</title></head><body>
<div id="sidebar">ads</div>
<div id="mw-content-text" class="mw-body-content"><div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
${body}
</div></div>
<div id="fx-footer-content">footer</div>
<script>track()</script>
</body></html>`;

/** A full build: infobox, misfiled spells row, weapon/armor/spell tables, requirements, related-builds footer. */
export const BUILD_HTML = shell('Test Paladin Build', `<p class="mw-empty-elt"></p>
<aside class="portable-infobox"><div class="er-build-infobox">
<div class="er-build-header"><div class="er-build-name">Test Paladin</div><div class="er-build-tagline">Level 150</div></div>
<div class="er-build-meta">${cell('Class', a('Vagabond'))}${cell('Level', '150')}${cell('Journey', 'NG+')}${cell('Focus', a('Faith'))}${cell('Playstyle', 'Melee')}</div>
<div class="er-build-section"><div class="er-build-heading">Attributes</div>${row('Primary Stats', `${a('Faith')} &amp; ${a('Strength')}`)}${row('Secondary Stats', `${a('Vigor')} &amp; ${a('Mind')}`)}</div>
<div class="er-build-section"><div class="er-build-heading">Equipment</div>${row('Weapon', `${a('Uchigatana')} (Keen) with ${a('Ash of War: Sacred Blade')}`)}${row('Off-Hand', a('Golden Order Seal'))}${row('Alternate Weapon')}${row('Shield', 'None')}${row('Armor', `${a("Rellana's Armor")}, ${a('Horned Warrior Gauntlets')} and any helm`)}</div>
<div class="er-build-section"><div class="er-build-heading">Talismans</div>${row('Talismans', `${a('Godfrey Icon')}, ${a("Assassin's Cerulean Dagger")}, ${a('Graven-School Talisman')}`)}${row('Alternates', a('Shard of Alexander'))}</div>
<div class="er-build-section"><div class="er-build-heading">Skills &amp; Spells</div>${row('Skills', a('Ash of War: Sacred Blade'))}${row('Spells', `${a('Comet Azur')} &amp; ${a('Flamberge')}`)}${row('Seal / Staff', a('Golden Order Seal'))}${row('Spirit Ash')}</div>
<div class="er-build-section"><div class="er-build-heading">Consumables &amp; Runes</div>${row('Flask Spread', 'Even split')}${row('Crystal Tear', a('Opaline Hardtear'))}${row('Alternate Tear', a('Crimsonburst Crystal Tear'))}${row('Great Runes', a("Godrick's Great Rune"))}${row('Arrows / Bolts')}</div>
</div></aside>
<p><b>Test Paladin</b> is a ${a('Build')} for ${a('Elden Ring')}. It is a made-up faith build used only in tests.</p>
<div class="row"><div class="col-sm-12"><div class="hpwidget"><div>video embed</div></div></div></div>
<h2 id="Why_Play" class="bonfire">Why Play the Test Paladin Build in Elden Ring</h2>
<p>Invented paragraph about swinging a sword and casting a prayer.</p>
<h2 id="Reqs" class="bonfire">Test Paladin Build Requirements</h2>
<p>To use everything in this build you need at least <b>40 Faith</b>, <b>11 Strength</b>, <b>15 Dexterity</b>. Anything above goes into damage.</p>
<table class="wikitable"><tbody>
<tr><th>Weapon</th><th>Type</th><th>Requires</th><th>Scaling</th><th>Weight</th><th>Skill</th><th>Passive</th></tr>
<tr><td>${a('Uchigatana')}</td><td>Katana</td><td>Strength 11, Dexterity 15</td><td>STR D / DEX D</td><td>5.5</td><td>Unsheathe</td><td>Hemorrhage 45</td></tr>
</tbody></table>
<table class="wikitable"><tbody>
<tr><th>Piece</th><th>Slot</th><th>Poise</th><th>Weight</th></tr>
<tr><td>${a("Rellana's Armor")}</td><td>Chest Armor</td><td>30</td><td>12.1</td></tr>
</tbody></table>
<table class="wikitable"><tbody>
<tr><th>Spell</th><th>FP Cost</th><th>Slots</th><th>Requires</th><th>Effect</th></tr>
<tr><td>${a('Comet Azur')}</td><td>40</td><td>3</td><td>Intelligence 60</td><td>Invented effect text</td></tr>
<tr><td>${a('Flamberge')}</td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<h2 id="Related_Elden_Ring_Builds" class="bonfire">Related Elden Ring Builds</h2>
<ul><li>${a('Faith Builds', 'All Faith Builds')}</li><li>${a('SOTE Builds', 'Shadow of the Erdtree Builds')}</li></ul>
<p>${a('Other Build')} ${a('Another Build')}</p>`);

/** A thin build: nothing but the infobox's free text, no tables. */
export const THIN_BUILD_HTML = shell('Thin Build', `<aside class="portable-infobox"><div class="er-build-infobox">
<div class="er-build-header"><div class="er-build-name">Thin</div><div class="er-build-tagline">Beginner</div></div>
<div class="er-build-meta">${cell('Class', a('Samurai'))}${cell('Level')}${cell('Focus', a('Dexterity'))}</div>
<div class="er-build-section">${row('Primary Stats', `${a('Dexterity')} &amp; ${a('Vigor')}`)}${row('Weapon', `${a('Uchigatana')} and ${a('Longbow')}`)}${row('Spells', 'None')}</div>
</div></aside>
<p><b>Thin</b> is a ${a('Build')} for ${a('Elden Ring')}. An invented beginner build.</p>`);

/** A non-build article in the new markup, for the generic page converter. */
export const ITEM_HTML = shell("Azur's Glintstone Staff", `<h2 id="Where" class="bonfire">Where to find Azur's Glintstone Staff</h2>
<ul><li>Raya Lucaria Academy</li><li>Nearest grace: ${a('Church of the Cuckoo')}</li></ul>
<h3 class="bonfire">Notes</h3><p>Reduces casting time.</p>
<script>track()</script>`);

/** The Builds index: build links, category links (…_Builds) and repeats. */
export const BUILDS_INDEX_HTML = shell('Builds', `<p>${a('Samurai Build')} ${a('Blood Dancer Build')} ${a('Samurai Build')}</p>
<p>${a('Faith Builds')} ${a('SOTE Builds')} ${a("Eleonora's Poleblade")} ${a('Star-Lined Samurai Build')}</p>`);
