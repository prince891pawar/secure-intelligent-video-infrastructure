export async function connectWithBoundedRetries(
  connect: () => Promise<unknown>,
  attempts: number,
  delayMs: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await connect();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Dependency connection failed");
}
