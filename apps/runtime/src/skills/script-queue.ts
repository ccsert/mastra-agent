/** Serialize model-issued batches without increasing sandbox concurrency. */
export function createScriptQueue(signal: AbortSignal, limit = 16) {
  let tail = Promise.resolve(),
    pending = 0;
  return async <T>(execute: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (pending >= limit) throw new Error("SKILL_CALL_LIMIT");
    pending++;
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal.throwIfAborted();
      return await execute();
    } finally {
      pending--;
      release();
    }
  };
}
