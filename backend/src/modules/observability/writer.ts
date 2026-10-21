import type { RequestEvent, EventSink } from './events.js';
export class EventWriter implements EventSink {
  private queue: Readonly<RequestEvent>[] = [];
  private active: Promise<void> | undefined;
  private closed = false;
  private lastLog = -Infinity;
  private reportedDrops = 0;
  droppedEvents = 0;
  writeFailures = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly insert: (events: readonly Readonly<RequestEvent>[]) => Promise<void>, private readonly log: (message: string, count: number) => void) {
    this.timer = setInterval(() => {
      if (this.droppedEvents > this.reportedDrops) { this.warn('observability_events_dropped',this.droppedEvents); this.reportedDrops = this.droppedEvents; }
      void this.flush();
    }, 100);
    this.timer.unref();
  }
  get depth() { return this.queue.length; }
  private warn(message: string, count: number) {
    if (Date.now() - this.lastLog < 10000) return;
    this.lastLog = Date.now();
    try { this.log(message, count); } catch { /* Logging cannot affect runtime. */ }
  }
  enqueue(event: Readonly<RequestEvent>) {
    if (this.closed || this.queue.length >= 256 || this.queue.filter((item) => item.projectId === event.projectId).length >= 64) {
      this.droppedEvents++;
      return;
    }
    this.queue.push(event);
    // Database work is started by the timer, never inside enqueue/onResponse.
  }
  flush(): Promise<void> {
    if (this.active) return this.active;
    if (!this.queue.length) return Promise.resolve();
    const batch = this.queue.splice(0, 32);
    this.active = Promise.resolve()
      .then(() => this.insert(batch))
      .catch(() => { this.writeFailures += batch.length; this.warn('observability_event_write_failed', this.writeFailures); })
      .finally(() => { this.active = undefined; });
    return this.active;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const deadline = Date.now() + 1000;
    while ((this.active || this.queue.length) && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.flush(), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1,deadline-Date.now())); })]);
      if (timer) clearTimeout(timer);
    }
    this.droppedEvents += this.queue.length;
    this.queue = [];
  }
}
