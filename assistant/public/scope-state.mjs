// A changed selection invalidates both data requests and responses already in flight.
export function createScopeRequests() {
  let revision = 0;
  const active = new Map();
  return {
    invalidate() {
      revision += 1;
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
    begin(kind) {
      active.get(kind)?.abort();
      const controller = new AbortController();
      const requestRevision = revision;
      active.set(kind, controller);
      return {
        signal: controller.signal,
        isCurrent: () => revision === requestRevision && active.get(kind) === controller && !controller.signal.aborted,
      };
    },
  };
}
