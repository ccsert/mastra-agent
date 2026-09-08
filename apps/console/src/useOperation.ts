import { useCallback, useRef, useState } from "react";
import { useLifetime } from "./useLifetime";

/** One user operation at a time; requests and feedback expire with the owning editor/dialog. */
export function useOperation() {
  const lifetime = useLifetime(),
    pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = useCallback(
    async (action: (signal: AbortSignal) => Promise<void>) => {
      const signal = lifetime();
      if (pending.current || signal.aborted) return;
      pending.current = true;
      setBusy(true);
      setError("");
      try {
        await action(signal);
      } catch (error) {
        if (!signal.aborted && !(error instanceof Error && error.name === "AbortError"))
          setError(error instanceof Error ? error.message : "操作失败");
      } finally {
        pending.current = false;
        if (!signal.aborted) setBusy(false);
      }
    },
    [lifetime],
  );
  return { busy, error, setError, run };
}
