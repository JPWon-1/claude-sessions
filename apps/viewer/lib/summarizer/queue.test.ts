import { describe, it, expect } from "vitest";
import { SerialQueue } from "./queue";

describe("SerialQueue", () => {
  it("runs jobs serially in submission order", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    const p1 = q.enqueue(async () => { await sleep(20); log.push("a"); return "A"; });
    const p2 = q.enqueue(async () => { log.push("b"); return "B"; });

    expect(await p1).toBe("A");
    expect(await p2).toBe("B");
    expect(log).toEqual(["a", "b"]);   // serial
  });

  it("propagates errors without breaking the queue", async () => {
    const q = new SerialQueue();
    const p1 = q.enqueue(async () => { throw new Error("boom"); });
    const p2 = q.enqueue(async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("ok");
  });
});
