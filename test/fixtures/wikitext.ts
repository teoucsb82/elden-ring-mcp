export const AZUR_STAFF = `{{Infobox Weapon
| title         = Azur's Glintstone Staff
| japanese  	= アズールの輝石杖<br/>(Azūru no Kisekijō)
| type          = Glintstone Staff
| skills        = [[No Skill]]
| weight        = 4.0
| sorcery_scaling   = 151
| incant_scaling    =
| str_scale     = D
| dex_scale     = -
| int_scale     = B
| fai_scale     = -
| arc_scale     = -
| str_req       = 10
| dex_req       = 0
| int_req       = 52
| fai_req       = 0
| arc_req       = 0
| effects       =
}}
'''Azur's Glintstone Staff''' is a [[Staves|Glintstone Staff]] and [[Weapons|catalyst]] found in {{ER}}.

==Acquisition==
Found in a secluded room on the highest level of the [[Church of the Cuckoo]]. The level can be accessed via the rooftops of the [[Academy of Raya Lucaria]].

From the [[Debate Parlor]] site of grace, go outside to the left until you meet two sorcerers.
`;

export const COMET_AZUR = `{{stub|missing data}}
{{Infobox_Item
| title       = Comet Azur
| type        = Sorcery
| sub_type    = Primeval
| item_effect = Fires a tremendous comet within a starry torrent
| fp_cost     = 40 (10)
| stamina_cost= 34
| slots_used  = 3
| int_req     = 60
| fai_req     = 0
| arc_req     = 0
| obtained    = [[Primeval Sorcerer Azur]]
}}
'''Comet Azur''' is a [[Sorceries|sorcery]] [[Spells|spell]] in {{ER}}.

==Acquisition==
'''Quest Item:''' [[Hermit Village]]
* Comet Azur is obtained by interacting with [[Primeval Sorcerer Azur]], found on the cliffs southeast of the Hermit Village in [[Mt. Gelmir]].
`;

export const GRAVEN_SCHOOL = `{{Infobox_Item
| title       = Graven-School Talisman
| type        = Talisman
| item_effect = Raises potency of sorceries
| weight      = 0.7
| sell_price  = 1,000
}}
'''Graven-School Talisman''' is a [[Talismans|talisman]] in {{ER}}.

Increases damage from sorceries by 8%. Can be stacked with the [[Graven-Mass Talisman]].

== Acquisition ==
* Obtained from a large pile of crystals in [[Raya Lucaria Academy]]. Look for an empty bookshelf on the north side of the room, which is an illusory wall.

{{Navbox Talismans}}
[[ru:Талисман могильной школы]]
`;

export const AZUR_CROWN = `{{Infobox Armor
| type       = head
| title      = Azur's Glintstone Crown
| weight     = 3.6
| effects    = Boosts the potency of [[Comet Azur]] by 15%. Increases {{stat|fp}} [[FP]] consumption by 15%.
| poise      = 4
}}

==Acquisition==
'''Location''': [[Primeval Sorcerer Azur]]
* Obtained upon completing [[Sorceress Sellen]]'s questline, then returning to the spot where [[Azur]] was found.
`;

export const RED_WOLF = `{{Infobox Boss
|title = Red Wolf of Radagon
|location = [[Academy of Raya Lucaria]]
|hp= 2,204
|runes= 14,000
|drops= [[Memory Stone]]
}}
'''{{PAGENAME}}''' is a [[boss]] in {{ER}}.

==Overview==
Giant wolves with red fur.
{| class="article-table"
! Move Name
|-
| Phase
|}
[[Category:Bosses]]
`;

export const SELLEN_QUEST = `{{Infobox Character
| title         = Sorceress Sellen
| location      = [[Waypoint Ruins]] cellar
| type          = [[Merchant]]
}}
'''Sorceress Sellen''' is a [[merchant]] [[NPC]] in {{ER}}.

==Quests==
===Questline progression===
#[[Waypoint Ruins]]
#*Sellen can be found in the cellar after defeating the [[Mad Pumpkin Head]]. Select "I wish to learn glintstone sorceries".
#Waypoint Ruins
#*Find Primeval Sorcerer Azur. Return to Sellen and select "I have a favor to ask" to obtain the Sellian Sealbreaker.
#[[Witchbane Ruins]]
#*After Starscourge Radahn has been defeated, speak to the shackled Sellen.
#*Attacking Sellen here will fail the questline.

==Notes==
* Killing Preceptor Seluvis early locks you out of the puppet step.
`;

// Real shapes the live wiki uses that the Sellen fixture does not cover:
// Patches is an NPC with a questline but an "Infobox Boss"; Leda writes a flat numbered list with
// no nested action bullets; Count Ymir heads the section "Questline steps"; invasion NPCs such as
// Eleonora use "Infobox Enemy". All four produced zero quest rows in the first real build.
export const PATCHES_QUEST = `{{Infobox Boss
| title         = Patches
| location      = [[Murkwater Cave]]
}}
'''Patches''' is an [[NPC]] in {{ER}}.

==Questline Progression==
#[[Murkwater Cave]]
#*Loot the chest to trigger Patches to jump down from above.
#*Continuing to attack him will fail the questline.
#[[Scenic Isle]]
#*Patches relocates here and resumes trading.
`;

export const LEDA_FLAT_QUEST = `{{Infobox Character
|title = Needle Knight Leda
|role = NPC
}}
'''Needle Knight Leda''' is an [[NPC]] in {{ER}}.

==Questline Progression==
#Defeat both Starscourge Radahn and Mohg, Lord of Blood. Leda will appear in front of Miquella's cocoon.
#Climb the stairs in the adjacent room and collect a letter from Leda.
#Siding against Leda at the Church of the Bud will fail the questline.
`;

export const YMIR_QUEST = `{{Infobox_Character
|title = Count Ymir
|role = NPC
}}
'''Count Ymir''' is an [[NPC]] in {{ER}}.

===Questline steps===
# [[Cathedral of Manus Metyr]]
#* Speak with Count Ymir to receive [[Hole-Laden Necklace]] and [[Ruins Map]]
# [[Finger Ruins of Rhia]] (or Dheo)
#* Ring the bell to receive [[Crimson Seed Talisman +1]]

==Quest items==
* [[Hole-Laden Necklace]]
`;

export const ELEONORA_QUEST = `{{Infobox Enemy
|title = Eleonora, Violet Bloody Finger
|location = [[Second Church of Marika]]
}}
'''Eleonora''' is an invader [[NPC]] in {{ER}}.

==Eleonora's Quest==
#[[Second Church of Marika]]
#*Use the summon sign to invade and defeat Eleonora for the [[Bloody Helice]].
`;

// A bare "Quests" section that only links the questline, ahead of the real steps. Now that flat "#"
// lists parse, the stub parses too and must not outrank the section that holds the actual steps.
export const STUB_THEN_STEPS = `{{Infobox Character
|title = Jolán, Swordhand of Night
|role = NPC
}}
'''Jolán''' is an [[NPC]] in {{ER}}.

==Quests==
#[[Count Ymir]]'s questline

===Questline steps===
#[[Cathedral of Manus Metyr]]
#*Speak with Jolán to receive the [[Swordhand of Night Jolán]] ashes.
#[[Finger Ruins of Rhia]]
#*Follow Jolán through the ruins.
#[[Taylew's Ruined Forge]]
#*Defeat Jolán to obtain her [[Night Sorceries]].
`;

export const MALFORMED = `{{Infobox Weapon
| title = Broken Page
| int_req = 12
`;
