export type PageActionStep = {
  id: string;
  target: string;
  label: string;
  before?: string;
  after?: string;
  status: "applying" | "verifying" | "applied" | "unknown" | "not-applied";
};
export type PageActionActivity = {
  id: string;
  title: string;
  pageKey: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  message: string;
  steps: PageActionStep[];
};

/** Local presentation state. The server receipt remains authoritative for completion. */
export function createPageActivity() {
  let snapshot: PageActionActivity | null = null;
  const listeners = new Set<() => void>();
  const publish = (value: PageActionActivity | null) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(id: string, title: string, pageKey: string) {
      publish({ id, title, pageKey, status: "running", message: title, steps: [] });
    },
    step(step: PageActionStep) {
      if (snapshot?.status !== "running") return;
      const steps = [...snapshot.steps];
      if (steps.at(-1)?.id === step.id) steps[steps.length - 1] = step;
      else steps.push(step);
      publish({ ...snapshot, steps: steps.slice(-40) });
    },
    finish(id: string, status: PageActionActivity["status"], message: string) {
      if (snapshot?.id === id)
        publish({
          ...snapshot,
          status,
          message,
          steps: snapshot.steps.map((step) =>
            status !== "running" && ["applying", "verifying"].includes(step.status)
              ? { ...step, status: "unknown" as const }
              : step,
          ),
        });
    },
    clear() {
      publish(null);
    },
  };
}
