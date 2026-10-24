import { EventEmitter } from "node:events";
import { stdin, stdout } from "node:process";
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  maskedInput,
  confirmHidden,
} from "../../experiments/storage/probe-auth-host-cli";

function terminal(tty = true) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: tty,
    isRaw: false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const output = { isTTY: tty, write: vi.fn() };
  return {
    input,
    output,
    streams: {
      input: input as unknown as typeof stdin,
      output: output as unknown as typeof stdout,
    },
  };
}
describe("operator masked credential input", () => {
  it("never echoes typed secrets and restores terminal state", async () => {
    const t = terminal();
    const result = maskedInput("Password (hidden): ", t.streams);
    t.input.emit("data", Buffer.from("synthetic-secret\r"));
    expect(await result).toBe("synthetic-secret");
    expect(t.output.write.mock.calls).toEqual([
      ["Password (hidden): "],
      ["\n"],
    ]);
    expect(t.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(t.input.listenerCount("data")).toBe(0);
  });
  it.each(["\u0003", "\u0004", "\u001b"])(
    "cancels safely on control input",
    async (control) => {
      const t = terminal();
      const result = maskedInput("Hidden: ", t.streams);
      t.input.emit("data", Buffer.from("synthetic" + control));
      await expect(result).rejects.toThrow("INPUT_CANCELLED");
      expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(t.output.write.mock.calls.flat().join("")).not.toContain(
        "synthetic",
      );
    },
  );
  it("refuses redirected or piped input before reading", async () => {
    const t = terminal(false);
    await expect(maskedInput("Hidden: ", t.streams)).rejects.toThrow(
      "INTERACTIVE_TERMINAL_REQUIRED",
    );
    expect(t.input.resume).not.toHaveBeenCalled();
    expect(t.output.write).not.toHaveBeenCalled();
  });
});

describe("nonsecret confirmation diagnostics", () => {
  const uuid = "a24b4c69-90cd-47c9-82b1-92083b86db7a";
  function confirm(t: ReturnType<typeof terminal>) {
    return confirmHidden(
      "Confirm (hidden): ",
      uuid,
      "execution-confirmation",
      t.streams,
    );
  }
  it("accepts the exact manually typed UUID and Enter without echo", async () => {
    const t = terminal();
    const result = confirm(t);
    for (const character of uuid) t.input.emit("data", Buffer.from(character));
    t.input.emit("data", Buffer.from("\r"));
    await expect(result).resolves.toBe(true);
    expect(t.output.write.mock.calls.flat().join("")).not.toContain(uuid);
  });
  it.each(["", " " + uuid, uuid + " ", uuid.toUpperCase(), "synthetic-secret"])(
    "rejects nonexact confirmation without retaining entered input",
    async (input) => {
      const t = terminal();
      const result = confirm(t);
      t.input.emit("data", Buffer.from(input + "\r"));
      await expect(result).rejects.toMatchObject({
        stage: "execution-confirmation",
        reason: "UUID_MISMATCH",
        message: "UUID_MISMATCH",
      });
      expect(t.output.write.mock.calls).toEqual([
        ["Confirm (hidden): "],
        ["\n"],
      ]);
    },
  );
  it.each([
    ["data", Buffer.from("synthetic-secret\u0003"), "INPUT_CANCELLED"],
    ["data", Buffer.from("synthetic-secret\u0004"), "INPUT_CANCELLED"],
    ["data", Buffer.from("synthetic-secret\u001b"), "INPUT_CANCELLED"],
    ["end", undefined, "TERMINAL_EOF"],
    ["error", Error("synthetic-secret"), "INPUT_ERROR"],
    ["data", Buffer.from("synthetic-secret\u0016"), "INPUT_ERROR"],
  ] as const)("classifies %s safely", async (event, payload, reason) => {
    const t = terminal();
    const result = confirm(t);
    t.input.emit(event, payload);
    await expect(result).rejects.toMatchObject({
      stage: "execution-confirmation",
      reason,
      message: reason,
    });
    expect(t.output.write.mock.calls.flat().join("")).not.toContain(
      "synthetic-secret",
    );
    expect(t.input.listenerCount("data")).toBe(0);
    expect(t.input.listenerCount("end")).toBe(0);
    expect(t.input.listenerCount("error")).toBe(0);
  });
  it("distinguishes raw-mode initialization failure without exposing its error", async () => {
    const t = terminal();
    t.input.setRawMode.mockImplementationOnce(() => {
      throw Error("synthetic-secret");
    });
    await expect(confirm(t)).rejects.toMatchObject({
      stage: "execution-confirmation",
      reason: "RAW_MODE_INITIALIZATION_FAILED",
    });
    expect(t.input.resume).not.toHaveBeenCalled();
    expect(t.input.listenerCount("data")).toBe(0);
  });
  it("classifies terminal restoration failure instead of escaping the handler", async () => {
    const t = terminal();
    t.input.setRawMode
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw Error("synthetic-secret");
      });
    const result = confirm(t);
    t.input.emit("data", Buffer.from(uuid + "\r"));
    await expect(result).rejects.toMatchObject({ reason: "INPUT_ERROR" });
  });
  it("classifies resume failures without retaining their message", async () => {
    const t = terminal();
    t.input.resume.mockImplementationOnce(() => {
      throw Error("synthetic-secret");
    });
    await expect(confirm(t)).rejects.toMatchObject({
      stage: "execution-confirmation",
      reason: "INPUT_ERROR",
      message: "INPUT_ERROR",
    });
  });
  it.each(["auth-confirmation", "registration-confirmation"] as const)(
    "retains only the fixed %s stage",
    async (stage) => {
      const t = terminal(false);
      await expect(
        confirmHidden("Confirm: ", uuid, stage, t.streams),
      ).rejects.toMatchObject({
        stage,
        reason: "INTERACTIVE_TERMINAL_REQUIRED",
      });
    },
  );
});
