let job: Promise<typeof import('../components/ReadingScreen')> | undefined;

/** The library can warm the reader without loading its language model before the first paint. */
export function loadReadingScreen() {
  if (!job) {
    job = import('../components/ReadingScreen');
    void job.catch(() => { job = undefined; });
  }
  return job.then(module => ({ default: module.ReadingScreen }));
}
