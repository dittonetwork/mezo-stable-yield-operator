// SPDX-License-Identifier: BUSL-1.1
// In-flight coalescing only. Completed work is never cached: a later retry must revalidate
// task timing/state. Different request bytes never share a verification result or signature.
export class WorkLimitExceeded extends Error {}
export class BoundedWork {
  #jobs = new Map();
  constructor(limit = 4, maxWaiters = 16) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxWaiters) || maxWaiters < 1) throw new Error("invalid work limits");
    this.limit = limit;
    this.maxWaiters = maxWaiters;
  }
  run(key, work) {
    let job = this.#jobs.get(key);
    if (!job) {
      if (this.#jobs.size >= this.limit) throw new WorkLimitExceeded("operator busy");
      job = { waiters: 0, promise: null };
      job.promise = Promise.resolve().then(work).finally(() => this.#jobs.delete(key));
      this.#jobs.set(key, job);
    }
    if (job.waiters >= this.maxWaiters) throw new WorkLimitExceeded("too many duplicate requests");
    job.waiters++;
    return job.promise.finally(() => { job.waiters--; });
  }
}
