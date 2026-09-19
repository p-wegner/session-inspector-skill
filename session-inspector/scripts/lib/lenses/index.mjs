/**
 * lenses/index.mjs — the lens registry for session-dashboard.mjs.
 *
 * A LENS is the problem-specific half of a dashboard: the questions that only
 * make sense for one workflow, next to the generic session numbers that always
 * apply. Adding one is a single file exporting { id, title, detect, analyze }:
 *
 *   detect({ meta, events, calls })       → boolean, "is this that kind of run?"
 *   analyze({ meta, events, calls, apiCalls, repoDir, path })
 *                                          → { headline[], questions[], sections[] }
 *
 *   headline  [{ label, value, note }]              — stat tiles
 *   questions [{ q, a, detail }]                    — the answers, stated
 *   sections  [{ title, note?, table:{cols,rows} }] — the evidence behind them
 *
 * `--lens auto` (the default) runs every lens whose detect() says yes, so a run
 * that is both a Spec Kit run and something else gets both panels.
 */

import * as speckit from "./speckit.mjs";
import * as cost from "./cost.mjs";

export const LENSES = [cost, speckit];

export function lensById(id) {
  return LENSES.find((l) => l.id === id) || null;
}

export function detectLenses(ctx) {
  return LENSES.filter((l) => { try { return l.detect(ctx); } catch { return false; } });
}
