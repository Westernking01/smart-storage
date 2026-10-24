import { describe, expect, it, vi } from "vitest";
import template from "../../experiments/storage/disposable-upload.config.template.json";
import { prepareDisposableFixture } from "../../experiments/storage/disposable-roundtrip-executor";
import { runOperatorRoundTrip } from "../../experiments/storage/disposable-roundtrip-host";

describe("operator host offline gates", () => {
  it("rejects disabled configuration before session acquisition", async () => {
    const f = await prepareDisposableFixture();
    const verifiedSession = vi.fn();
    await expect(
      runOperatorRoundTrip({
        ...f,
        config: template,
        authorization: {},
        qualification: {},
        verifiedSession,
      }),
    ).rejects.toThrow();
    expect(verifiedSession).not.toHaveBeenCalled();
  });
  it("requires qualification and matching permission review before session acquisition", async () => {
    const f = await prepareDisposableFixture();
    const { source, encoded, ...manifest } = f;
    const verifiedSession = vi.fn();
    const config = {
      ...template,
      ...manifest,
      enabled: true,
      fixtureVerificationReference: "offline fixture",
      createReadPermissionReviewReference: "review-a",
    };
    for (const qualification of [
      {},
      {
        claimDirectory: "unqualified",
        retentionAndPowerLossReview: "unqualified",
        effectivePermissionsReview: "review-b",
        ordinarySessionVerificationReview: "unqualified",
      },
    ]) {
      await expect(
        runOperatorRoundTrip({
          source,
          encoded,
          config,
          authorization: {},
          qualification,
          verifiedSession,
        }),
      ).rejects.toThrow();
    }
    expect(verifiedSession).not.toHaveBeenCalled();
  });
});
