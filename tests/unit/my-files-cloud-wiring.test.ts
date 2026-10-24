import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement } from "react";
vi.mock("server-only", () => ({}));
const fixtures = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn() }));
vi.mock("@/components/cloud-page-access", () => ({
  cloudPageAccess: fixtures.access,
  CloudAccessNotice: () => null,
}));
vi.mock("@/lib/backend/operations", () => ({ listFiles: fixtures.list }));
import { AccountFileRecords } from "../../src/components/account-file-records";
import MyFiles from "../../src/app/my-files/page";
it("actual My Files metadata component wires authenticated cloud restoration independently of staging", async () => {
  fixtures.access.mockResolvedValue({
    state: "authenticated",
    account: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  fixtures.list.mockResolvedValue({
    next: null,
    files: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        displayName: "display.txt",
        originalName: "original.txt",
        originalMime: "text/plain",
        originalBytes: "16000",
        storedBytes: "100",
        revision: 0,
        category: "document",
        createdAt: "2026-10-24T00:00:00Z",
      },
    ],
  });
  const result = await AccountFileRecords({});
  const html = renderToStaticMarkup(result);
  expect(html).toContain("Cloud file explorer");
  expect(html).toContain("Download and restore");
  expect(html).toContain("display.txt");
  expect(html).toContain("15.6 KiB");
  expect(html).not.toContain("text/plain");
  expect(html).not.toContain("locally staged compressed");
});
it("keeps My Files centered on cloud records and routes upload/local controls to their pages", async () => {
  const page = await MyFiles({ searchParams: Promise.resolve({}) });
  const children = Children.toArray(page.props.children).filter(isValidElement);
  expect(
    children
      .filter((child) => typeof child.type !== "string")
      .map((child) => child.type),
  ).toEqual([AccountFileRecords]);
  const links = children.filter((child) => child.type === "p");
  const html = links.map((child) => renderToStaticMarkup(child)).join("");
  expect(html).toContain('href="/compress"');
  expect(html).toContain('href="/local-storage"');
});
