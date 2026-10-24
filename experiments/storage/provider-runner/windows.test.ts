import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WindowsCodec,
  ProtectedCredentials,
  initializePrivateDirectory,
  privateFile,
  checkDirectory,
  createPrivateApproval,
} from "./windows-store.js";
import { Ledger } from "./ledger.js";
import { USERS, slot } from "./manifest.js";

describe.skipIf(process.platform !== "win32")(
  "disposable native Windows integration",
  () => {
    let temporary: string;
    let directory: string;
    let originalProfile: string | undefined;
    const codec = new WindowsCodec();
    beforeAll(() => {
      originalProfile = process.env.USERPROFILE;
      temporary = mkdtempSync(
        join(tmpdir(), "smart-storage-windows-preflight-"),
      );
      process.env.USERPROFILE = temporary; // Disposable canonical root; never real ledger.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw new Error("NETWORK_FORBIDDEN");
        }),
      );
    });
    afterAll(() => {
      if (originalProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalProfile;
      vi.unstubAllGlobals();
      const full = resolve(temporary);
      const base = resolve(tmpdir()) + sep + "smart-storage-windows-preflight-";
      if (!full.startsWith(base)) throw new Error("UNSAFE_TEST_CLEANUP");
      rmSync(full, { recursive: true, force: true }); // Only disposable local fixtures.
    });
    it("DPAPI round-trips disposable Unicode plaintext and rejects corrupt ciphertext", () => {
      const text = JSON.stringify({
        secret: "DISPOSABLE_ONLY_é_中文",
        token: "FAKE_NO_AUTH",
      });
      const cipher = codec.encode(text);
      expect(cipher).not.toContain("DISPOSABLE");
      expect(codec.decode(cipher)).toBe(text);
      expect(() => codec.decode("invalid cipher")).toThrow(
        "PRIVATE_STORE_FAILURE",
      );
    }, 60_000);
    it("creates a new disposable approval with private inherited ACLs", () => {
      const file = createPrivateApproval(
        { fixture: "DISPOSABLE_APPROVAL_ONLY" },
        process.cwd(),
      );
      expect(file.startsWith(temporary + sep)).toBe(true);
      expect(privateFile(file, process.cwd())).toBe(file);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        fixture: "DISPOSABLE_APPROVAL_ONLY",
      });
    }, 60000);
    it("initializes only the disposable directory and verifies inherited private file ACLs", () => {
      directory = initializePrivateDirectory(process.cwd());
      expect(directory.startsWith(temporary + sep)).toBe(true);
      checkDirectory(directory, process.cwd());
      const file = join(directory, "disposable-credentials.dpapi");
      const accounts = (["A", "B"] as const).map((label) => ({
        label,
        ...USERS[label],
        password: `DISPOSABLE_TEST_ONLY_PASSWORD_${label}`,
      }));
      writeFileSync(
        file,
        codec.encode(
          JSON.stringify({ status: "CREATED_AND_VERIFIED", accounts }),
        ),
      );
      expect(privateFile(file, process.cwd())).toBe(file);
      const adapter = new ProtectedCredentials(file, process.cwd());
      for (const actor of ["A", "B"] as const) {
        const result = adapter.get(actor);
        expect(result.id).toBe(USERS[actor].id);
        expect(result.password).toBe(`DISPOSABLE_TEST_ONLY_PASSWORD_${actor}`);
      }
      expect(() => initializePrivateDirectory(process.cwd())).toThrow(
        "EXISTING_PRIVATE_DIRECTORY_DO_NOT_RESET",
      );
    }, 60_000);
    it("native encrypted ledger survives restart and excludes a second process lock", () => {
      const ledger = new Ledger(directory, codec);
      ledger.initialize();
      ledger.acquire();
      try {
        expect(ledger.load().bytes).toBe(0);
        const child = `const fs=require('node:fs');try{fs.openSync(process.argv[1],'wx');process.exitCode=2}catch(e){if(e.code!=='EEXIST')throw e;process.stdout.write('LOCK_BLOCKED')}`;
        expect(
          execFileSync(
            process.execPath,
            ["-e", child, join(directory, "lock")],
            { encoding: "utf8", windowsHide: true },
          ).trim(),
        ).toBe("LOCK_BLOCKED");
        ledger.update((s) => {
          s.sessions.A = { token: "DISPOSABLE_FAKE_TOKEN", verified: false };
        });
        expect(readFileSync(join(directory, "journal"), "utf8")).not.toContain(
          "DISPOSABLE_FAKE_TOKEN",
        );
        const reservation = ledger.reserve(
          {
            id: "rest-A",
            actor: "A",
            method: "POST",
            purpose: "rest-upload",
            path: slot(0),
            body: new Uint8Array(256),
            expected: "allow",
          },
          true,
        );
        ledger.update((s) => {
          s.entries[reservation.sequence - 1].state = "completed";
        });
      } finally {
        ledger.release();
      }
      const reopened = new Ledger(directory, codec);
      reopened.acquire();
      try {
        expect(reopened.load().sessions.A?.token).toBe("DISPOSABLE_FAKE_TOKEN");
        expect(reopened.state.allocations).toBe(1);
        expect(reopened.state.bytes).toBe(256);
        for (const name of ["marker", "journal", "snapshot", "lock"])
          privateFile(join(directory, name), process.cwd());
      } finally {
        reopened.release();
      }
    }, 60_000);
    it("compiled helper inspection preserves disposable encrypted state and redacts tokens", () => {
      const originals = Object.fromEntries(
        ["marker", "journal", "snapshot"].map((f) => [
          f,
          readFileSync(join(directory, f)),
        ]),
      );
      const output = execFileSync(
        process.execPath,
        [
          resolve(".cache/provider-runner/build/continuation-helper-cli.js"),
          "--inspect",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, USERPROFILE: temporary },
          timeout: 60000,
        },
      );
      expect(output).not.toContain("DISPOSABLE_FAKE_TOKEN");
      expect(JSON.parse(output).cleanupExecuted).toBe(false);
      for (const [file, bytes] of Object.entries(originals))
        expect(readFileSync(join(directory, file)).equals(bytes)).toBe(true);
    }, 60000);
    it("compiled renewal diagnosis preserves encrypted fixtures and suppresses secrets", () => {
      const originals = Object.fromEntries(
        ["marker", "journal", "snapshot"].map((f) => [
          f,
          readFileSync(join(directory, f)),
        ]),
      );
      const output = execFileSync(
        process.execPath,
        [
          resolve(".cache/provider-runner/build/continuation-helper-cli.js"),
          "--diagnose-renewal",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, USERPROFILE: temporary },
          timeout: 60000,
        },
      );
      expect(output).not.toContain("DISPOSABLE_FAKE_TOKEN");
      expect(JSON.parse(output).providerRequests).toBe(0);
      expect(JSON.parse(output).recoveryAuthorized).toBe(false);
      for (const [file, bytes] of Object.entries(originals))
        expect(readFileSync(join(directory, file)).equals(bytes)).toBe(true);
    }, 60000);
    it("rejects a disposable file with a broad Everyone ACL", () => {
      const file = join(directory, "unsafe-disposable.txt");
      writeFileSync(file, "DISPOSABLE_NO_CREDENTIAL");
      const script =
        "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$a=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read',[Security.AccessControl.AccessControlType]::Allow));[IO.File]::SetAccessControl($p,$a)";
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { input: file, encoding: "utf8", windowsHide: true },
      );
      expect(() => privateFile(file, process.cwd())).toThrow(
        "PRIVATE_STORE_FAILURE",
      );
    }, 60_000);
    it("guarded state ACL repair preserves files and rejects unexpected artifacts", () => {
      const previous = process.env.USERPROFILE;
      const profile = join(temporary, "guarded-acl-test");
      mkdirSync(profile);
      process.env.USERPROFILE = profile;
      try {
        const target = initializePrivateDirectory(process.cwd());
        const names = ["marker", "journal", "snapshot"];
        for (const name of names)
          writeFileSync(join(target, name), `DISPOSABLE_${name}`);
        const script =
          "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$a=[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-21-3058023354-1746979206-3201508519-1002'),'ReadAndExecute',[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));[IO.Directory]::SetAccessControl($p,$a)";
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { input: target, encoding: "utf8", windowsHide: true },
        );
        expect(() => checkDirectory(target, process.cwd())).toThrow(
          "PRIVATE_STORE_FAILURE",
        );
        const repair = resolve(
          "experiments/storage/provider-runner/repair-ledger-acl.ps1",
        );
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-File", repair],
          { encoding: "utf8", windowsHide: true },
        );
        checkDirectory(target, process.cwd());
        for (const name of names) {
          privateFile(join(target, name), process.cwd());
          expect(readFileSync(join(target, name), "utf8")).toBe(
            `DISPOSABLE_${name}`,
          );
        }
        writeFileSync(join(target, "unexpected.txt"), "DISPOSABLE");
        expect(() =>
          execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-File", repair],
            { stdio: "pipe", windowsHide: true },
          ),
        ).toThrow();
      } finally {
        process.env.USERPROFILE = previous;
      }
    }, 60_000);
  },
);
