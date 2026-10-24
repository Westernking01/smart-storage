import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { build } from "vite";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type Page,
} from "@playwright/test";
import { resolve } from "node:path";

let server: Server;
let browser: Browser;
let page: Page;
let origin: string;
const evaluate = (code: string) => page.evaluate(code);
beforeAll(async () => {
  const directory = resolve(".cache/transfer-browser-build");
  await build({
    configFile: false,
    envDir: false,
    logLevel: "error",
    oxc: { jsx: { development: false } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: {
      alias: {
        "@": resolve("src"),
        "next/navigation": resolve("tests/fixtures/transfer-router.tsx"),
        "next/link": resolve("tests/fixtures/transfer-router.tsx"),
      },
    },
    build: {
      outDir: directory,
      emptyOutDir: false,
      lib: {
        entry: resolve("tests/fixtures/transfer-browser.tsx"),
        formats: ["es"],
        fileName: "harness",
      },
    },
  });
  server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<div id="root"></div><script type="module" src="/harness.js"></script>',
      );
      return;
    }
    const name = req.url?.slice(1) ?? "";
    if (!/^(?:assets\/)?[\w.-]+\.js$/.test(name)) {
      res.writeHead(404).end();
      return;
    }
    void readFile(resolve(directory, name)).then(
      (bytes) => {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bytes);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("HARNESS_ADDRESS");
  origin = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(origin).origin
      ? route.continue()
      : route.abort(),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.goto(origin);
  await page
    .waitForFunction("!!window.transferHarness", undefined, { timeout: 15000 })
    .catch((error) => {
      throw Error(errors.join("; ") || String(error));
    });
  await evaluate("transferHarness.seed()");
}, 60000);
afterEach(async () => {
  await page?.close();
});

async function mount() {
  await evaluate("transferHarness.mount()");
  await page.getByText("Prepared uploads on this device").waitFor();
  await page.locator("summary").click();
}
async function reached(stage: string) {
  await page.waitForFunction(`transferHarness.stats().reached === '${stage}'`);
}

it.each(["write", "verify", "publish"])(
  "fences late %s completion on account switch",
  async (stage) => {
    await mount();
    await evaluate(`transferHarness.block('${stage}')`);
    await page
      .getByRole("button", { name: "Check or continue upload" })
      .click();
    await reached(stage);
    await evaluate("transferHarness.mount(transferHarness.B)");
    await page.waitForFunction(
      "!document.body.textContent.includes('Uploading prepared blocks')",
    );
    await evaluate("transferHarness.release()");
    await expect
      .poll(() => evaluate("transferHarness.stats().refreshes"))
      .toBe(0);
    await expect.poll(() => page.getByRole("status").textContent()).toBe("");
    await expect
      .poll(() => evaluate("transferHarness.stats().publications"))
      .toBe(stage === "publish" ? 1 : 0);
    expect(
      await page
        .getByRole("button", { name: "Check or continue upload" })
        .count(),
    ).toBe(0);
  },
);

it("drops a late listing after logout and denies new operations", async () => {
  await evaluate("transferHarness.block('listing'); transferHarness.mount()");
  await reached("listing");
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change')); transferHarness.release()",
  );
  await browserExpect(
    page.getByRole("button", { name: "Download and restore" }),
  ).toHaveCount(0);
  await browserExpect(page.locator('input[type="file"]')).toHaveCount(0);
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeDisabled();
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
});

it("fences an invalid session on 401 before further transfer dispatch", async () => {
  await mount();
  await evaluate("transferHarness.invalidate()");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Check or continue upload" }),
  ).toHaveCount(0);
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
  expect(await evaluate("transferHarness.stats().publications")).toBe(0);
  expect(await evaluate("transferHarness.stats().refreshes")).toBe(0);
});

it("continues acknowledged blocks for the same owner without resending", async () => {
  await mount();
  await evaluate("transferHarness.block('verify')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("verify");
  await page.getByRole("button", { name: "Stop current transfer" }).click();
  await evaluate("transferHarness.release()");
  await browserExpect(
    page.getByRole("button", { name: "Stop current transfer" }),
  ).toHaveCount(0);
  expect(await evaluate("transferHarness.stats().puts")).toBe(1);
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Upload published",
  );
  expect(await evaluate("transferHarness.stats().puts")).toBe(1);
});

it("unmount aborts a blocked upload and remount accepts only fresh callbacks", async () => {
  await mount();
  await evaluate("transferHarness.block('write')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("write");
  await evaluate("transferHarness.unmount()");
  await browserExpect(page.getByRole("heading")).toHaveCount(0);
  await evaluate(
    "transferHarness.release(); transferHarness.mount(transferHarness.B)",
  );
  await browserExpect(page.getByRole("heading")).toHaveText(
    "Development cloud files",
  );
  await browserExpect(page.getByRole("status")).toHaveText("");
  expect(await evaluate("transferHarness.stats().publications")).toBe(0);
  expect(await evaluate("transferHarness.stats().refreshes")).toBe(0);
});

it.each(["stream", "reading"])(
  "cancels %s download on cross-tab invalidation without publishing output",
  async (stage) => {
    await mount();
    await evaluate(`transferHarness.block('${stage}')`);
    await page.getByRole("button", { name: "Download and restore" }).click();
    await reached(stage);
    await evaluate(
      "window.dispatchEvent(new StorageEvent('storage', { key: 'sb-offline-auth-token' })); transferHarness.release()",
    );
    await expect
      .poll(() => evaluate("transferHarness.stats().cancelled"))
      .toBe(1);
    await browserExpect(
      page.getByRole("button", { name: "Save to Device" }),
    ).toHaveCount(0);
    await browserExpect(page.getByRole("status")).not.toContainText("verified");
  },
);

it("stops compression worker on pagehide and ignores queued worker completion", async () => {
  await evaluate(`
    window.workerTerminations = 0;
    window.Worker = class {
      onmessage = null;
      onerror = null;
      postMessage(data) {
        if (data.method === 'prepare') { window.pendingWorker = this.onmessage; return; }
        queueMicrotask(() => this.onmessage?.({data: {result: data.method === 'ready' ? 'ready' : 'listed', files: []}}));
      }
      terminate() { window.workerTerminations++; }
    };
    transferHarness.mount(transferHarness.A, true);
  `);
  await browserExpect(page.getByLabel("Original file")).toBeEnabled();
  await page.getByLabel("Original file").setInputFiles({
    name: "fixture.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("fixture"),
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await evaluate(
    "window.dispatchEvent(new Event('pagehide')); window.pendingWorker({data: {result: 'verified', file: new Blob(['stale']), downloadName: 'stale.txt'}})",
  );
  await browserExpect(page.getByRole("status")).toContainText(
    "Session changed",
  );
  await browserExpect(
    page.getByRole("link", { name: "Save verified original bytes" }),
  ).toHaveCount(0);
  expect(await evaluate("window.workerTerminations")).toBe(1);
});

it("reconciles a cancelled publication using only a receipt for the same owner", async () => {
  await mount();
  await evaluate("transferHarness.block('publish')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("publish");
  await page.getByRole("button", { name: "Stop current transfer" }).click();
  await evaluate("transferHarness.release()");
  await browserExpect(
    page.getByRole("button", { name: "Stop current transfer" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Upload published",
  );
  expect(await evaluate("transferHarness.stats().puts")).toBe(1);
  expect(await evaluate("transferHarness.stats().publications")).toBe(1);
});

it("ignores a delayed receipt after cross-tab invalidation", async () => {
  await mount();
  await evaluate("transferHarness.block('publish')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("publish");
  await page.getByRole("button", { name: "Stop current transfer" }).click();
  await evaluate("transferHarness.release()");
  await browserExpect(
    page.getByRole("button", { name: "Stop current transfer" }),
  ).toHaveCount(0);
  await evaluate("transferHarness.block('receipt')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("receipt");
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change')); transferHarness.release()",
  );
  await browserExpect(page.getByRole("status")).not.toContainText(
    "Upload published",
  );
  expect(await evaluate("transferHarness.stats().refreshes")).toBe(0);
  expect(await evaluate("transferHarness.stats().publications")).toBe(1);
});

it("renders acknowledged upload progress, savings and blocks competing actions", async () => {
  await mount();
  await evaluate("transferHarness.block('write')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("write");
  await browserExpect(
    page.getByRole("progressbar", { name: "Uploading" }),
  ).toHaveAttribute("value", "0");
  await browserExpect(page.locator(".transfer-activity")).toContainText(
    "payload savings (excludes manifest)",
  );
  await browserExpect(
    page.getByRole("button", { name: "Download and restore" }),
  ).toBeDisabled();
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Stop current transfer" }).click();
  await evaluate("transferHarness.release()");
  await browserExpect(page.locator(".transfer-activity")).toContainText(
    "Awaiting reconciliation",
  );
});
it("renders download stage and publishes output only after verified restoration", async () => {
  await mount();
  await evaluate("transferHarness.block('stream')");
  await page.getByRole("button", { name: "Download and restore" }).click();
  await reached("stream");
  await browserExpect(
    page.getByRole("progressbar", { name: "Downloading" }),
  ).toBeVisible();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toHaveCount(0);
  await evaluate("transferHarness.release()");
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await browserExpect(page.locator(".transfer-activity")).toContainText(
    "Completed",
  );
});
it("keeps mobile controls accessible by keyboard and removes device selection", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount();
  await page.addStyleTag({
    content: await readFile(resolve("src/styles/foundation.css"), "utf8"),
  });
  await browserExpect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Check or continue upload" }).focus();
  await browserExpect(
    page.getByRole("button", { name: "Check or continue upload" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
});

it("shows honest empty and unavailable states", async () => {
  await evaluate("transferHarness.empty(); transferHarness.mount()");
  await browserExpect(page.getByText("No ready cloud files.")).toBeVisible();
  await evaluate("transferHarness.unmount()");
  await page.getByRole("heading").waitFor({ state: "detached" });
  await evaluate("transferHarness.fail(); transferHarness.mount()");
  await browserExpect(page.getByRole("status")).toContainText(
    "Development cloud unavailable",
  );
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeDisabled();
  await browserExpect(page.getByText("No ready cloud files.")).toHaveCount(0);
});

it("Upload to Cloud opens the picker and dispatches the existing prepared-cloud pipeline", async () => {
  await mount();
  await evaluate("transferHarness.seedPicker()");
  await page
    .getByRole("button", { name: "Upload to Cloud", exact: true })
    .click();
  await browserExpect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Upload fixture.txt", exact: true })
    .click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Upload published",
  );
  expect(await evaluate("transferHarness.stats().puts")).toBe(1);
  expect(await evaluate("transferHarness.stats().publications")).toBe(1);
});

it("handles empty prepared files, Compress navigation, cancellation and account switching offline", async () => {
  await mount();
  await page
    .getByRole("button", { name: "Upload to Cloud", exact: true })
    .click();
  await browserExpect(page.getByRole("dialog")).toContainText(
    "No eligible prepared compressed files",
  );
  await browserExpect(
    page.getByRole("link", { name: "Prepare a file on Overview" }),
  ).toHaveAttribute("href", "/");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await browserExpect(page.getByRole("dialog")).toHaveCount(0);
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeFocused();
  await evaluate("transferHarness.seedPicker()");
  await page
    .getByRole("button", { name: "Upload to Cloud", exact: true })
    .click();
  await browserExpect(
    page.getByRole("button", { name: "Upload fixture.txt", exact: true }),
  ).toBeVisible();
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change'))",
  );
  await browserExpect(page.getByRole("dialog")).toHaveCount(0);
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
});

it("does not upload dropped device originals", async () => {
  await mount();
  await page.locator(".volume-workflow").evaluate((section) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["raw original"], "raw.txt"));
    section.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
    );
  });
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
  await browserExpect(page.locator('input[type="file"]')).toHaveCount(0);
});

it("Overview offers cloud navigation only after verified account preparation", async () => {
  await evaluate(`window.Worker = class {
    onmessage = null; onerror = null; prepared = false;
    postMessage(data) {
      if (data.method === 'prepare') this.prepared = true;
      const result = data.method === 'ready' ? {result:'ready'} :
        data.method === 'prepare' ? {result:'prepared'} :
        {result:'listed', files:this.prepared ? [{id:'prepared',name:'verified.txt',originalName:'verified.txt',mime:'text/plain',phase:'prepared',cloudPrepared:true,createdAt:null,originalBytes:100,compressedBytes:50,uploadedBytes:0,attemptedTransferBytes:0}] : []};
      queueMicrotask(() => this.onmessage?.({data:result}));
    }
    terminate() {}
  }; transferHarness.mount(transferHarness.A, true, 'all')`);
  await browserExpect(page.getByLabel("Original file")).toBeEnabled();
  await browserExpect(
    page.getByRole("link", { name: "Upload to Cloud" }),
  ).toHaveCount(0);
  await page.getByLabel("Original file").setInputFiles({
    name: "verified.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("original"),
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await browserExpect(
    page.getByRole("link", { name: "Upload to Cloud" }),
  ).toHaveAttribute("href", "/compress?prepared=prepared#cloud-heading");
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
});

it("keeps Upload to Cloud disabled while authorized listing is pending", async () => {
  await evaluate("transferHarness.block('listing'); transferHarness.mount()");
  await reached("listing");
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeDisabled();
  await evaluate("transferHarness.release()");
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeEnabled();
});

it("blocks uploads at exhausted quota without disabling eligible downloads", async () => {
  await evaluate("transferHarness.exhaustQuota(); transferHarness.mount()");
  await browserExpect(page.getByRole("alert")).toContainText(
    "No unreserved account quota",
  );
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeDisabled();
  await browserExpect(
    page.getByRole("button", { name: "Download and restore", exact: true }),
  ).toBeEnabled();
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
});

it("shows allocation denial and disables new uploads without dispatching bytes", async () => {
  await mount();
  await evaluate("transferHarness.denyAllocation()");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(page.getByRole("alert")).toContainText(
    "Database allocation has not authorized Storage writes",
  );
  await browserExpect(
    page.getByRole("button", { name: "Upload to Cloud", exact: true }),
  ).toBeDisabled();
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
  expect(await evaluate("transferHarness.stats().publications")).toBe(0);
});

it.each(["files", "compress", "recent", "storage"])(
  "renders distinct %s tools over the same local staging data",
  async (mode) => {
    await evaluate(`window.Worker = class {
    onmessage = null; onerror = null;
    postMessage(data) {
      const files = ['old','new'].map((name,i) => ({id:name,name:name+'.txt',originalName:name+'.txt',mime:'text/plain',phase:'prepared',createdAt:i?'2026-10-22T12:00:00Z':'2026-10-21T12:00:00Z',originalBytes:100,compressedBytes:50,uploadedBytes:0,attemptedTransferBytes:0}));
      queueMicrotask(() => this.onmessage?.({data:data.method==='ready'?{result:'ready'}:{result:'listed',files}}));
    }
    terminate() {}
  }; transferHarness.mount(transferHarness.A, true, '${mode}')`);
    await browserExpect(page.locator(".local-file-row")).toHaveCount(2);
    await browserExpect(page.getByLabel("Original file")).toHaveCount(0);
    await browserExpect(
      page.getByLabel("Local browser storage metrics"),
    ).toHaveCount(mode === "storage" || mode === "compress" ? 1 : 0);
    await browserExpect(
      page.getByRole("button", { name: "Rename", exact: true }),
    ).toHaveCount(mode === "files" || mode === "storage" ? 1 : 0);
    await browserExpect(
      page.getByRole("button", { name: "Restore & verify" }),
    ).toHaveCount(mode === "recent" ? 0 : 1);
    await browserExpect(page.locator(".local-file-row").first()).toContainText(
      "new.txt",
    );
    await browserExpect(page.locator(".local-file-row time")).toHaveCount(
      mode === "recent" ? 2 : 0,
    );
  },
);
it.each(["verify", "publish"])(
  "shows an indeterminate %s stage without invented percentages",
  async (stage) => {
    await mount();
    await evaluate("transferHarness.block('" + stage + "')");
    await page
      .getByRole("button", { name: "Check or continue upload" })
      .click();
    await reached(stage);
    const progress = page.getByRole("progressbar");
    await browserExpect(progress).toHaveAccessibleName(
      stage === "verify" ? "Verifying" : "Publishing",
    );
    if (stage === "publish")
      expect(await progress.getAttribute("value")).toBe(null);
    await evaluate("transferHarness.release()");
    await browserExpect(page.locator(".transfer-activity")).toContainText(
      "Completed",
    );
  },
);

it("prepares on Overview and reuses the same payload across Compress, folders and Recent", async () => {
  await evaluate("transferHarness.mount(transferHarness.A, true, 'all')");
  await browserExpect(page.getByLabel("Original file")).toBeEnabled();
  await page.getByLabel("Original file").setInputFiles({
    name: "journey.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("connected workflow ".repeat(1024)),
  });
  await page
    .getByRole("button", { name: "Prepare locally", exact: true })
    .click();
  await browserExpect(page.getByRole("status")).toContainText(
    "exact restoration verified",
    { timeout: 30000 },
  );
  await evaluate("transferHarness.mount(transferHarness.A, true, 'compress')");
  await browserExpect(page.getByLabel("Original file")).toHaveCount(0);
  await browserExpect(
    page.getByRole("link", { name: "Upload to Cloud" }),
  ).toHaveAttribute("href", /compress\?prepared=/);
  await browserExpect(page.getByText(/Codec: gzip/)).toBeVisible();
  await evaluate("transferHarness.mount(transferHarness.A, true, 'files')");
  page.once("dialog", (d) => d.accept("Work"));
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Move local file").selectOption("Work");
  await page.getByLabel("Open folder", { exact: true }).selectOption("Work");
  await browserExpect(page.locator(".local-file-row")).toContainText(
    "journey.txt",
  );
  page.once("dialog", (d) => d.accept("Notes"));
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Move local file").selectOption("Work/Notes");
  await page
    .getByLabel("Open folder", { exact: true })
    .selectOption("Work/Notes");
  await browserExpect(page.locator(".local-file-row")).toContainText(
    "journey.txt",
  );
  await evaluate("transferHarness.mount(transferHarness.A, true, 'recent')");
  await browserExpect(
    page.locator(".local-file-row").filter({ hasText: "journey.txt" }),
  ).toContainText("Staged locally");
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
}, 60000);

it("does not fabricate folder persistence without a backend and clears records on session change", async () => {
  await evaluate("transferHarness.mountRecords()");
  await browserExpect(
    page.getByRole("link", { name: "Open file record", exact: true }),
  ).toHaveAttribute("href", /app\/files\//);
  await browserExpect(
    page.getByRole("button", { name: "New folder", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Search cloud files and folders").fill("missing");
  await browserExpect(
    page.getByText("No matching files or folders."),
  ).toBeVisible();
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change'))",
  );
  await browserExpect(page.getByRole("status")).toContainText(
    "Session changed",
  );
  await browserExpect(
    page.getByRole("button", { name: "Select fixture.txt", exact: true }),
  ).toHaveCount(0);
  expect(await evaluate("transferHarness.stats().puts")).toBe(0);
});

it("restores exact bytes in app, saves only on click and discards temporary output", async () => {
  await mount();
  await evaluate(
    "Object.defineProperty(window, 'showSaveFilePicker', {value: undefined, configurable: true})",
  );
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.getByRole("button", { name: "Download and restore" }).click();
  const ready = page.getByRole("region", { name: "Restored File Ready" });
  await browserExpect(ready).toContainText("16000 bytes");
  await browserExpect(ready).toContainText("Integrity verified");
  expect(downloads).toBe(0);
  const result = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save to Device" }).click();
  const saved = await result;
  expect(await readFile((await saved.path())!)).toEqual(
    Buffer.from("browser fixture ".repeat(1000)),
  );
  expect(saved.suggestedFilename()).toBe("fixture.txt");
  await page.getByRole("button", { name: "Discard Restored Copy" }).click();
  await browserExpect(ready).toHaveCount(0);
  expect(
    await evaluate(
      `(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('smart-storage-account-restores-v1-' + transferHarness.A); let count=0; for await (const _ of dir.keys()) count++; return count; })()`,
    ),
  ).toBe(0);
});

it.each(["logout", "switch", "pagehide"])(
  "clears restored output on %s",
  async (kind) => {
    await mount();
    await page.getByRole("button", { name: "Download and restore" }).click();
    await browserExpect(
      page.getByRole("button", { name: "Save to Device" }),
    ).toBeVisible();
    await evaluate(
      kind === "switch"
        ? "transferHarness.mount(transferHarness.B)"
        : `window.dispatchEvent(new Event('${kind === "logout" ? "smart-storage-session-change" : "pagehide"}'))`,
    );
    await browserExpect(
      page.getByRole("button", { name: "Save to Device" }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        evaluate(
          `(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('smart-storage-account-restores-v1-' + transferHarness.A); let count=0; for await (const _ of dir.keys()) count++; return count; })()`,
        ),
      )
      .toBe(0);
  },
);

it("clears both published payload copies and retains checkpoint history and cloud records", async () => {
  await mount();
  await evaluate("transferHarness.seedPicker()");
  await page
    .getByRole("button", { name: "Upload to Cloud", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Upload fixture.txt", exact: true })
    .click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Upload published",
  );
  expect(await evaluate("transferHarness.localPayloads()")).toEqual({
    available: 0,
    retained: 1,
    removed: 1,
  });
  expect(
    await evaluate("transferHarness.localPayloads('cloud-offline')"),
  ).toEqual({ available: 1, retained: 2, removed: 1 });
  await browserExpect(
    page.getByRole("button", { name: "Download and restore" }),
  ).toBeVisible();
  expect(await evaluate("transferHarness.stats().publications")).toBe(1);
  await page
    .getByRole("button", { name: "Upload to Cloud", exact: true })
    .click();
  await browserExpect(page.getByRole("dialog")).toContainText(
    "No eligible prepared compressed files",
  );
  await evaluate("transferHarness.mount(transferHarness.A, true, 'compress')");
  await browserExpect(
    page.getByRole("heading", { name: "Your local workspace is empty" }),
  ).toBeVisible();
  await browserExpect(page.getByRole("status")).toContainText(
    "No files are staged",
  );
  await evaluate("transferHarness.mount(transferHarness.A, true, 'storage')");
  await browserExpect(page.getByRole("status")).toContainText(
    "No files are staged",
  );
});

it("retains payloads on cleanup failure and local-only cleanup never republishes", async () => {
  await mount();
  await evaluate("transferHarness.failCleanup()");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Local cleanup pending",
  );
  expect(
    await evaluate("transferHarness.localPayloads('cloud-offline')"),
  ).toEqual({ available: 1, retained: 1, removed: 0 });
  await page
    .getByRole("button", { name: "Clear published local payload" })
    .click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Local cleanup pending",
  );
  expect(await evaluate("transferHarness.stats().publications")).toBe(1);
});

it("retains payloads for uncertain publication", async () => {
  await mount();
  await evaluate("transferHarness.block('publish')");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await reached("publish");
  await page.getByRole("button", { name: "Stop current transfer" }).click();
  await evaluate("transferHarness.release()");
  await browserExpect(
    page.getByRole("button", { name: "Stop current transfer" }),
  ).toHaveCount(0);
  expect(
    await evaluate("transferHarness.localPayloads('cloud-offline')"),
  ).toEqual({ available: 1, retained: 1, removed: 0 });
});

it("published payload removal is idempotent and rejects another owner", async () => {
  await mount();
  expect(await evaluate("transferHarness.crossOwnerCleanup()")).toBe("DENIED");
  expect(
    await evaluate("transferHarness.localPayloads('cloud-offline')"),
  ).toEqual({ available: 1, retained: 1, removed: 0 });
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(page.getByRole("status")).toContainText(
    "Upload published",
  );
  const revisions = (await evaluate("transferHarness.cleanupAgain()")) as {
    before: number;
    after: number;
  };
  expect(revisions.after).toBe(revisions.before);
  expect(
    await evaluate("transferHarness.localPayloads('cloud-offline')"),
  ).toEqual({ available: 0, retained: 1, removed: 1 });
});

it("uses the explicit save-location picker and fences a late picker after logout", async () => {
  await mount();
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await evaluate(
    `window.savedBytes=[]; window.closedSave=0; window.saveOpens=0; window.showSaveFilePicker=async () => ({ createWritable: async () => { window.saveOpens++; return {write:async b=>window.savedBytes.push(...b), close:async()=>window.closedSave++,abort:async()=>{}}; }});`,
  );
  await page.getByRole("button", { name: "Save to Device" }).click();
  await expect.poll(() => evaluate("window.closedSave")).toBe(1);
  expect(
    await evaluate(
      "new TextDecoder().decode(new Uint8Array(window.savedBytes))",
    ),
  ).toBe("browser fixture ".repeat(1000));
  await evaluate(
    "window.showSaveFilePicker=()=>new Promise(r=>window.releasePicker=r)",
  );
  await page.getByRole("button", { name: "Save to Device" }).click();
  await page.waitForFunction("!!window.releasePicker");
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change')); window.releasePicker({createWritable:async()=>{window.saveOpens++; throw Error();}})",
  );
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toHaveCount(0);
  expect(await evaluate("window.saveOpens")).toBe(1);
});

it("retains local payload on failed publication", async () => {
  await mount();
  await evaluate("transferHarness.denyPublication()");
  await page.getByRole("button", { name: "Check or continue upload" }).click();
  await browserExpect(page.getByRole("alert")).toContainText(
    "Restricted publisher authority",
  );
  expect(
    await evaluate("transferHarness.localPayloads('cloud-offline')"),
  ).toEqual({ available: 1, retained: 1, removed: 0 });
  expect(await evaluate("transferHarness.stats().publications")).toBe(1);
});

it("rejects corrupt cloud payload without offering save and clears partial output", async () => {
  await mount();
  await evaluate("transferHarness.corruptDownload()");
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(page.locator(".transfer-activity")).toContainText(
    "Failed",
  );
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      evaluate(
        `(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('smart-storage-account-restores-v1-' + transferHarness.A); let count=0; for await (const _ of dir.keys()) count++; return count; })()`,
      ),
    )
    .toBe(0);
});

it("My Files restores without any local payload, saves explicitly and keeps its cloud record", async () => {
  await evaluate(
    "(async () => { await transferHarness.removeLocalStaging(); transferHarness.mountExplorer(); })()",
  );
  await browserExpect(
    page.getByRole("button", { name: "New folder", exact: true }),
  ).toBeEnabled();
  await evaluate(
    "Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true})",
  );
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("region", { name: "Restored File Ready" }),
  ).toContainText("Integrity verified");
  expect(downloads).toBe(0);
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save to Device" }).click();
  expect(await readFile((await (await saving).path())!)).toEqual(
    Buffer.from("browser fixture ".repeat(1000)),
  );
  await page.getByRole("button", { name: "Discard Restored Copy" }).click();
  await browserExpect(
    page.getByRole("region", { name: "Restored File Ready" }),
  ).toHaveCount(0);
  await browserExpect(
    page.getByRole("button", { name: "Select fixture.txt", exact: true }),
  ).toBeVisible();
});

it("My Files creates nested folders, renames, moves and persists its reviewed metadata contract across refresh", async () => {
  await evaluate("transferHarness.mountExplorer()");
  const create = async (name: string) => {
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await browserExpect(
      page.getByRole("form", { name: "Name editor" }),
    ).toHaveCount(0);
  };
  await browserExpect(
    page.getByRole("button", { name: "New folder", exact: true }),
  ).toBeEnabled();
  await create("Work");
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await create("Notes");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await browserExpect(
    page.getByRole("navigation", { name: "Folder breadcrumbs" }),
  ).toContainText("Work");
  await browserExpect(
    page.getByRole("navigation", { name: "Folder breadcrumbs" }),
  ).toContainText("Notes");
  await page
    .getByRole("navigation", { name: "Folder breadcrumbs" })
    .getByRole("button", { name: "Root", exact: true })
    .click();
  await page.getByLabel("Actions for fixture.txt", { exact: true }).click();
  await page
    .getByRole("button", { name: "Move file fixture.txt", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Move file destination" });
  await dialog.getByRole("button", { name: "Work", exact: true }).click();
  await dialog.getByRole("button", { name: "Notes", exact: true }).click();
  await dialog.getByRole("button", { name: "Move here", exact: true }).click();
  await browserExpect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByLabel("Actions for fixture.txt", { exact: true }).click();
  await page
    .getByRole("button", { name: "Rename file fixture.txt", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("renamed.txt");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await browserExpect(
    page.getByRole("button", { name: "Select renamed.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Folder breadcrumbs" })
    .getByRole("button", { name: "Root", exact: true })
    .click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await page.reload();
  await page.waitForFunction("!!window.transferHarness");
  await evaluate("transferHarness.mountExplorer()");
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await browserExpect(
    page.getByRole("button", { name: "Select renamed.txt", exact: true }),
  ).toBeVisible();
});

it.each(["switch", "corrupt", "cancel"])(
  "My Files restoration fences %s results",
  async (mode) => {
    await evaluate(
      "(async () => { await transferHarness.removeLocalStaging(); transferHarness.mountExplorer(); })()",
    );
    await browserExpect(
      page.getByRole("button", { name: "New folder", exact: true }),
    ).toBeEnabled();
    if (mode === "corrupt") await evaluate("transferHarness.corruptDownload()");
    else await evaluate("transferHarness.block('stream')");
    await page.getByRole("button", { name: "Download and restore" }).click();
    if (mode === "cancel") {
      await reached("stream");
      await page.getByRole("button", { name: "Cancel restoration" }).click();
      await evaluate("transferHarness.release()");
    }
    if (mode === "switch") {
      await reached("stream");
      await evaluate(
        "transferHarness.mountExplorer(transferHarness.B); transferHarness.release()",
      );
    }
    if (mode !== "switch")
      await browserExpect(
        page.getByRole("region", { name: "Cloud restoration" }),
      ).toContainText(mode === "cancel" ? "cancelled" : "failed");
    await browserExpect(
      page.getByRole("button", { name: "Save to Device" }),
    ).toHaveCount(0);
  },
);

it.each([390, 1440])(
  "My Files folder icons, keyboard navigation, search and views work at %spx",
  async (width) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addStyleTag({
      content: await readFile(resolve("src/styles/foundation.css"), "utf8"),
    });
    await evaluate("transferHarness.mountExplorer()");
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Documents");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await page
      .getByLabel("Actions for folder Documents", { exact: true })
      .click();
    await page.getByRole("button", { name: "Rename folder Documents" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Projects");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await browserExpect(
      page.getByRole("button", { name: "Projects", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Grid view" }).click();
    await browserExpect(
      page.getByRole("list", { name: "Folder contents" }),
    ).toHaveClass(/--grid/);
    expect(
      await page
        .getByRole("button", { name: "Projects", exact: true })
        .locator("svg")
        .count(),
    ).toBe(1);
    await page.getByRole("button", { name: "Projects", exact: true }).focus();
    await page.keyboard.press("Enter");
    await browserExpect(page.getByText("This folder is empty.")).toBeVisible();
    await page.getByLabel("Search cloud files and folders").fill("fixture");
    await browserExpect(
      page.getByRole("button", { name: "Select fixture.txt", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Sort cloud files").selectOption("type");
    await page.getByRole("button", { name: "List view" }).click();
    await browserExpect(
      page.getByRole("list", { name: "Folder contents" }),
    ).toHaveClass(/--list/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  },
);

it("My Files clears a completed restored copy on session invalidation", async () => {
  await evaluate("transferHarness.mountExplorer()");
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change'))",
  );
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toHaveCount(0);
});

it("My Files never reports completion when output preparation fails", async () => {
  await evaluate("transferHarness.mountExplorer()");
  await evaluate(
    "FileSystemFileHandle.prototype.getFile = async () => {throw Error('fixture output failure')}",
  );
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("region", { name: "Cloud restoration" }),
  ).toContainText("failed");
  await browserExpect(
    page.getByRole("region", { name: "Restored File Ready" }),
  ).toHaveCount(0);
});

it("Strict Mode effect replay does not fabricate a session change or disable cloud restoration", async () => {
  await evaluate("transferHarness.mountExplorerStrict()");
  await browserExpect(
    page.getByRole("button", { name: "New folder", exact: true }),
  ).toBeEnabled();
  await browserExpect(
    page.getByText("Session changed. Refresh to load authorized records."),
  ).toHaveCount(0);
  await browserExpect(
    page.getByText("Session changed. Restored copy is unavailable."),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Download and restore" }).click();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toBeVisible();
  await evaluate(
    "window.dispatchEvent(new Event('smart-storage-session-change'))",
  );
  await browserExpect(
    page.getByText("Session changed. Refresh to load authorized records."),
  ).toBeVisible();
  await browserExpect(
    page.getByRole("button", { name: "Save to Device" }),
  ).toHaveCount(0);
});
