export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTranslationWorker } = await import("./lib/server-translation-queue");
    startTranslationWorker();
  }
}
