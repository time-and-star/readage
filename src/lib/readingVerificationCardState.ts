export type ReadingVerificationOutcome = 'recognized' | 'incorrect' | 'uncertain' | 'guessed' | 'skipped';

export interface VerificationSubmission {
  outcome: ReadingVerificationOutcome;
  selectedOptionId?: string;
}

/** Serialize an answer and its optional guess correction, including save retries. */
export class VerificationSubmissionGate {
  busy = false;
  saved: VerificationSubmission | null = null;
  failed: VerificationSubmission | null = null;

  canSubmit(submission: VerificationSubmission): boolean {
    return !this.busy
      && (!this.failed || (this.failed.outcome === submission.outcome
        && this.failed.selectedOptionId === submission.selectedOptionId))
      && (!this.saved || (this.saved.outcome === 'recognized' && submission.outcome === 'guessed'));
  }

  async submit(
    submission: VerificationSubmission,
    persist: (outcome: ReadingVerificationOutcome, selectedOptionId?: string) => Promise<void>,
  ): Promise<'saved' | 'busy' | 'ignored'> {
    if (this.busy) return 'busy';
    if (!this.canSubmit(submission)) return 'ignored';
    this.busy = true;
    this.failed = null;
    try {
      await persist(submission.outcome, submission.selectedOptionId);
      this.saved = submission;
      return 'saved';
    } catch (error) {
      this.failed = submission;
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
