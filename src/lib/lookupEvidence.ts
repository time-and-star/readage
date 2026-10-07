export interface LookupEvidenceState { saved: boolean; pending?: Promise<void> }

/** Refreshing a dictionary view shares the original learning action, including a pending save. */
export async function saveLookupEvidenceOnce(state: LookupEvidenceState, save: () => Promise<void>): Promise<void> {
  if (state.saved) return;
  if (!state.pending) {
    state.pending = Promise.resolve().then(save).then(() => { state.saved = true; });
    void state.pending.finally(() => { state.pending = undefined; }).catch(() => {});
  }
  await state.pending;
}
