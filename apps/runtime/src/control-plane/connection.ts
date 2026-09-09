/** Readiness means recent authenticated control-plane contact, not model/tool availability. */
export class ControlConnection {
  private lastSuccess: number | null = null;
  private unavailable = false;
  constructor(private readonly now: () => number = Date.now) {}
  record(status: number) {
    if (status >= 200 && status < 300) {
      this.lastSuccess = this.now();
      this.unavailable = false;
    } else if (status === 0 || status === 401 || status === 403 || status >= 500)
      this.unavailable = true;
  }
  snapshot() {
    const ready =
      !this.unavailable && this.lastSuccess !== null && this.now() - this.lastSuccess < 15000;
    return {
      status: ready ? "ready" : "unavailable",
      lastContactAt: this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString(),
    };
  }
}
