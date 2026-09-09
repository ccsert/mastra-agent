import { useCallback, useEffect, useRef } from "react";

/** Requests and their UI callbacks expire with the mounted session, project, or editor. */
export function useLifetime() {
  const controller = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  return useCallback(() => controller.current.signal, []);
}
