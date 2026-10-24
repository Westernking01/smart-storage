export type TransferProgress = {
  stage:
    | "Preparing"
    | "Compressing"
    | "Uploading"
    | "Downloading"
    | "Verifying"
    | "Decompressing"
    | "Publishing"
    | "Saving"
    | "Completed"
    | "Awaiting reconciliation"
    | "Failed"
    | "Cancelled";
  bytes?: number;
  total?: number;
};
export type ProgressListener = (progress: TransferProgress) => void;
export function compressionSummary(original: number, encoded: number) {
  return original > 0
    ? original.toLocaleString() +
        " original bytes · " +
        encoded.toLocaleString() +
        " encoded bytes · " +
        Math.max(0, (1 - encoded / original) * 100).toFixed(1) +
        "% payload savings (excludes manifest)"
    : original + " original bytes · " + encoded + " encoded bytes";
}

export function transferError(error: unknown) {
  const code = error instanceof Error ? error.message : "TRANSFER_FAILED";
  if (/INTEGRITY|CORRUPT|HASH|LENGTH|MANIFEST/.test(code))
    return "Integrity verification failed. No verified restoration is available. Upload holds may still require reconciliation.";
  if (/UNAUTH|FORBIDDEN|OWNER|ACCOUNT/.test(code))
    return "This account is not authorized for this file. Sign in again to continue.";
  if (/NOT_FOUND|MISSING/.test(code))
    return "The file or a required block is unavailable. Check recovery before trying again.";
  if (/QUOTA|LIMIT|SIZE/.test(code))
    return "The file exceeds an available size or quota limit.";
  return "Transfer unavailable. Check this device’s prepared uploads; uncertain uploads require reconciliation before retrying.";
}
