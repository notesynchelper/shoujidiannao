/**
 * Shared state-machine types for the pair flow.
 *
 * The state machines themselves live in `pair-device1.ts` and
 * `pair-device2.ts`; this file holds the value types that flow over the
 * `onState` callback so UI code (`pair-block.ts`) can typecheck against
 * a single source.
 *
 * Cross-ref: ROADMAP §2.6.1 (state transitions), §6.10 (UI state table).
 */

import type { VaultMeta } from '@obsync/proto';

/** Rendered SAS payload — digits like `042-815`, two emoji glyphs. */
export interface SasDisplay {
  /** 6-digit decimal string, **without** the connecting dash. */
  digits: string;
  /** Pair of indices into `EMOJI_POOL_256` (range [0,255] each). */
  emojiIndices: [number, number];
}

/** Device-1 (key sender) UI states. */
export type D1State =
  | { phase: 'idle' }
  | { phase: 'initializing' }
  | {
      phase: 'code_displayed';
      pair_code: string;
      expires_at: number; // epoch ms
    }
  | {
      phase: 'sas_pending';
      sas: SasDisplay;
      pinned_commit_p: Uint8Array;
    }
  | { phase: 'sealed' }
  | { phase: 'error'; message: string }
  | { phase: 'expired' };

/** Device-2 (key receiver) UI states. */
export type D2State =
  | { phase: 'prompt_code' }
  | { phase: 'claiming' }
  | {
      phase: 'sas_pending';
      sas: SasDisplay;
      pinned_commit_d: Uint8Array;
      vault: VaultMeta;
    }
  | { phase: 'decrypting' }
  | { phase: 'ready'; masterKey: Uint8Array; vault: VaultMeta }
  | { phase: 'error'; message: string };
