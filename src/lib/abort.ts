interface AbortLikeError extends Error {
  code?: string;
}

export interface AbortSignalLike {
  aborted?: boolean;
  reason?: unknown;
  addEventListener?: (
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
}

export function createAbortError(message = "请求已取消"): AbortLikeError {
  const error = new Error(message) as AbortLikeError;
  error.name = "AbortError";
  error.code = "ECANCELED";
  return error;
}

export function normalizeAbortError(reason: unknown, fallbackMessage = "请求已取消") {
  if (reason instanceof Error) {
    const error = reason as AbortLikeError;
    error.name = error.name || "AbortError";
    if (error.code === "ERR_CANCELED" || !error.code) {
      error.code = "ECANCELED";
    }
    return error;
  }

  return createAbortError(
    typeof reason === "string" && reason.trim() ? reason.trim() : fallbackMessage,
  );
}

export function isAbortError(error: any) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ECANCELED" ||
    error?.code === "ERR_CANCELED"
  );
}

export function throwIfAborted(signal?: AbortSignalLike | null, fallbackMessage?: string) {
  if (!signal?.aborted) return;
  throw normalizeAbortError(signal.reason, fallbackMessage);
}

export function abortableDelay(
  delayMs: number,
  signal?: AbortSignalLike | null,
  fallbackMessage = "请求已取消",
) {
  throwIfAborted(signal, fallbackMessage);

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, delayMs));

    (timer as NodeJS.Timeout).unref?.();

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(normalizeAbortError(signal?.reason, fallbackMessage));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
