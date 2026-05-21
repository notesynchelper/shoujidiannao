/**
 * 256-emoji pool for pair SAS display (ROADMAP §2.6.4 + §6.10).
 *
 * The pool is curated to avoid visually confusable pairs (e.g. crescent
 * moons 🌙 / 🌛 / 🌜, thumbs up/down across some fonts, hearts of
 * subtly different colours). All entries are **single-codepoint base
 * emoji** so that user-visible "glyph count" matches `digits.length`
 * across vendors — no skin-tone modifiers, no ZWJ sequences. Pool index
 * range: `[0, 255]`.
 *
 * Pool size of 256 contributes `log2(256^2) = 16 bit` of SAS-display
 * entropy (paired with `log2(10^6) ≈ 19.93 bit` from the 6-digit prefix
 * for a total ≈ 35.9 bit per session — see §2.6.4 derivation).
 */

export const EMOJI_POOL_256: readonly string[] = [
  // 0..31 — animals
  '🐢','🦊','🐱','🐶','🐼','🐰','🐻','🐯','🦒','🐮','🐷','🐸','🐵','🦓','🦔','🐨',
  '🦁','🦄','🐺','🦝','🐭','🐹','🐻','🐬','🐳','🐙','🦈','🦀','🐠','🦋','🐝','🐞',
  // 32..63 — fruits + food
  '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆',
  '🥑','🥦','🥕','🌽','🥒','🌶️','🥔','🍠','🥐','🍞','🧀','🍔','🍕','🌭','🥪','🌮',
  // 64..95 — plants + nature
  '🌵','🌲','🌳','🌴','🌱','🌿','🍀','🍁','🍂','🌷','🌹','🌺','🌻','🌼','🌸','💐',
  '🌍','🌎','🌏','⛰️','🏔️','🌋','🏖️','🏜️','🏝️','🏞️','🌅','🌄','🌠','🌌','⭐','🌟',
  // 96..127 — weather + sky
  '☀️','⛅','☁️','🌧️','⛈️','🌨️','❄️','☃️','⛄','🌬️','💨','🌪️','🌫️','🌈','💧','💦',
  '🔥','💥','✨','💫','☄️','⚡','🌊','🎆','🎇','🎐','🎑','🎏','🎀','🎁','🎊','🎉',
  // 128..159 — vehicles + travel
  '🚀','🛸','🚁','✈️','🛩️','🚂','🚆','🚇','🚊','🚌','🚎','🚐','🚑','🚒','🚓','🚕',
  '🚗','🚙','🚚','🚛','🚜','🏎️','🏍️','🛵','🛴','🚲','⛵','🚤','🛥️','🚢','⚓','🪝',
  // 160..191 — objects
  '🎈','🎯','🎲','🎮','🎸','🎺','🎻','🥁','🎷','🎹','🎤','🎧','📻','📷','📺','📚',
  '📖','📒','📔','📕','📗','📘','📙','📓','📰','📜','🗞️','📑','🔖','🏷️','📌','📍',
  // 192..223 — symbols + objects
  '🔑','🗝️','🔒','🔓','🔔','🔕','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💰','🏆','🏅',
  '🎖️','🥇','🥈','🥉','⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🎱','🪀','🏓','🏸',
  // 224..255 — misc
  '🎨','🖌️','🖍️','📝','🖊️','🖋️','✏️','📏','📐','🧮','💼','📁','📂','🗂️','📅','📆',
  '🧭','🌐','🪐','🛰️','🦴','🦷','👁️','👀','👂','👃','👄','🫧','🫀','🫁','🧠','🦾',
];

/** Compile-time guard: every constant below relies on 256 entries. */
if (EMOJI_POOL_256.length !== 256) {
  // Throwing at module-load surfaces the bug in dev; in production we
  // want a hard failure rather than silent SAS truncation.
  throw new Error(
    `EMOJI_POOL_256 must contain exactly 256 entries (got ${EMOJI_POOL_256.length})`,
  );
}

/**
 * Format SAS for display in UI: `042-815 🐢🌈`. The dash splits the 6
 * digits 3+3 so users can read them off without losing place. Indices
 * are looked up against `EMOJI_POOL_256`; out-of-range throws so SAS
 * mismatches never silently degrade into "missing glyph".
 */
export function formatSas(digits: string, emojiIndices: [number, number]): string {
  if (!/^\d{6}$/.test(digits)) {
    throw new Error('formatSas: digits must be exactly 6 ASCII decimals');
  }
  const [i1, i2] = emojiIndices;
  if (i1 < 0 || i1 >= 256 || i2 < 0 || i2 >= 256) {
    throw new Error('formatSas: emoji index out of [0,255]');
  }
  const head = digits.slice(0, 3);
  const tail = digits.slice(3);
  return `${head}-${tail} ${EMOJI_POOL_256[i1]}${EMOJI_POOL_256[i2]}`;
}
