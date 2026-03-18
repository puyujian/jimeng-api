import { AsyncLocalStorage } from "node:async_hooks";

export interface OutboundLogContext {
  ability?: string | null;
  mode?: "legacy" | "pool" | null;
  accountId?: string | null;
  accountEmail?: string | null;
  accountLabel?: string | null;
  apiKeyId?: string | null;
}

const outboundLogContextStorage = new AsyncLocalStorage<OutboundLogContext>();

export function getOutboundLogContext() {
  const store = outboundLogContextStorage.getStore();
  return store ? { ...store } : null;
}

export function runWithOutboundLogContext<T>(
  context: OutboundLogContext,
  handler: () => T
) {
  const current = outboundLogContextStorage.getStore() || {};
  return outboundLogContextStorage.run(
    {
      ...current,
      ...context,
    },
    handler
  );
}
