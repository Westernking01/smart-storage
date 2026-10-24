import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend/operations", () => ({
  ownerContext: mocks.owner,
  BackendError: class extends Error {
    constructor(
      public code: string,
      public status: number,
    ) {
      super(code);
    }
  },
}));
vi.mock("@/lib/backend/config", () => ({
  backendConfig: () => ({ origin: "http://localhost:3000" }),
  validMutationOrigin: (headers: Headers, origin: string) =>
    headers.get("origin") === origin,
}));
import { GET, POST } from "../../src/app/api/file-explorer/route";
import { BackendError } from "../../src/lib/backend/operations";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue({ id, client: { rpc: mocks.rpc } });
  mocks.rpc.mockResolvedValue({
    data: { folders: [], breadcrumbs: [], files: [], next: null },
    error: null,
  });
});
const request = (body: unknown, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/file-explorer", {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
it("requires a verified ordinary owner before any RPC", async () => {
  mocks.owner.mockRejectedValue(new BackendError("UNAUTHENTICATED", 401));
  expect(
    (await GET(new Request("http://localhost:3000/api/file-explorer"))).status,
  ).toBe(401);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("uses bounded folder listing with no caller-supplied owner", async () => {
  expect(
    (
      await GET(
        new Request(
          "http://localhost:3000/api/file-explorer?sort=size&offset=25",
        ),
      )
    ).status,
  ).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("ss_explorer_list", {
    p_parent: null,
    p_query: "",
    p_sort: "size",
    p_offset: 25,
  });
});
it("fails closed on absent backend contracts instead of persisting folders in the browser", async () => {
  mocks.rpc.mockResolvedValue({
    error: { code: "PGRST202", message: "private catalog details" },
  });
  const response = await GET(
    new Request("http://localhost:3000/api/file-explorer"),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("FOLDER_BACKEND_UNAVAILABLE");
});
it("rejects origin and owner injection without dispatch", async () => {
  expect(
    (
      await POST(
        request(
          { action: "create", id, parent: null, name: "Work" },
          "https://wrong.invalid",
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        request({
          action: "create",
          id,
          parent: null,
          name: "Work",
          ownerId: id,
        }),
      )
    ).status,
  ).toBe(422);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("sends only metadata movement and preserves revision fencing", async () => {
  mocks.rpc.mockResolvedValue({
    data: { id, folderId: null, revision: 2 },
    error: null,
  });
  expect(
    (await POST(request({ action: "move", id, folder: null, revision: 1 })))
      .status,
  ).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("ss_file_move", {
    p_file: id,
    p_folder: null,
    p_revision: 1,
  });
});
it("sanitizes permission failures without retrying or falling back to privileged authority", async () => {
  mocks.rpc.mockResolvedValue({
    error: { code: "42501", message: "sensitive internal message" },
  });
  const response = await POST(
    request({ action: "move", id, folder: null, revision: 1 }),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("sensitive");
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
