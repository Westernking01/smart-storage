import { describe, expect, it } from "vitest";
import { attachmentName, parseFileMetadata } from "@/lib/domain/file-metadata";
import {
  parseCreateSession,
  parseDecimalBytes,
} from "@/lib/domain/control-contracts";
describe("bounded Phase 2 control contracts", () => {
  const input = {
    idempotencyKey: "local_request_key_123",
    metadata: {
      originalName: "résumé.docx",
      originalMime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    originalBytes: "19864",
    sourceSha256: "a".repeat(64),
    format: "compression-spike",
    version: 1,
  };
  it("preserves Unicode filenames and MIME as untrusted metadata", () => {
    expect(parseCreateSession(input).metadata).toEqual(input.metadata);
    expect(attachmentName(input.metadata)).toBe("résumé.docx");
    expect(attachmentName()).toBe("verified-restoration.bin");
    expect(
      attachmentName({ originalName: "CON.txt", originalMime: null }),
    ).toBe("_CON.txt");
  });
  it.each([
    "../file.txt",
    "a\\file.txt",
    "line\r\n.txt",
    "x\u202eexe.txt",
    "é".repeat(128),
    "..",
    " ",
  ])("rejects unsafe metadata %j", (name) => {
    expect(() =>
      parseFileMetadata({ originalName: name, originalMime: null }),
    ).toThrow("FILE_METADATA_INVALID");
  });
  it("rejects active MIME parameter injection and unknown metadata fields", () => {
    expect(() =>
      parseFileMetadata({
        originalName: "a.html",
        originalMime: "text/html; charset=utf-8",
      }),
    ).toThrow();
    expect(() =>
      parseFileMetadata({ ...input.metadata, objectPath: "foreign" }),
    ).toThrow();
    expect(
      attachmentName({ originalName: "report:2026?.docx", originalMime: null }),
    ).toBe("report_2026_.docx");
  });
  it("preserves bigint decimal precision and rejects noncanonical/overflow sizes", () => {
    expect(parseDecimalBytes("9223372036854775807")).toBe(
      "9223372036854775807",
    );
    for (const value of [
      1,
      "01",
      "-1",
      "1e2",
      "9223372036854775808",
      "9".repeat(1000),
    ])
      expect(() => parseDecimalBytes(value)).toThrow("BYTE_COUNT_INVALID");
  });
  it("rejects caller-selected owners/paths, unknown versions and unapproved file caps", () => {
    for (const delta of [
      { ownerId: "attacker" },
      { objectPath: "attacker" },
      { version: 2 },
      { originalBytes: "33554433" },
    ])
      expect(() => parseCreateSession({ ...input, ...delta })).toThrow();
    expect(
      parseCreateSession({ ...input, originalBytes: "0" }).originalBytes,
    ).toBe("0");
  });
});
