package cn.readage.app;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** One reader owns the store; tapped cards run before queued passive learning work. */
final class DictionaryReadQueue {
    private final AtomicLong sequence = new AtomicLong();
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new PriorityBlockingQueue<>());
    private static final class Read implements Runnable, Comparable<Read> {
        final int priority; final long sequence; final Runnable action;
        Read(int priority, long sequence, Runnable action) { this.priority = priority; this.sequence = sequence; this.action = action; }
        @Override public void run() { action.run(); }
        @Override public int compareTo(Read other) {
            int compared = Integer.compare(priority, other.priority);
            return compared != 0 ? compared : Long.compare(sequence, other.sequence);
        }
    }
    void execute(Runnable action) { worker.execute(new Read(0, sequence.getAndIncrement(), action)); }
    void executeBackground(Runnable action) { worker.execute(new Read(1, sequence.getAndIncrement(), action)); }
    void shutdown() { worker.shutdownNow(); }
}
