// Features: F-14 the SFTP transport against a real SSH server (ssh2 in-process): connect with a password, list, put + rename, get, mkdir; wrong password refused
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSftp, memoryBox, isInterchangeFile, validateMailbox } from "./mailbox";
import { startSftpServer } from "../../../e2e/fixtures/sftp-server";

let port: number;
let root: string;
let close: () => Promise<void>;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "van-"));
  fs.mkdirSync(path.join(root, "in"));
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "in", "RXO_204.edi"), "ISA*00*test~");
  ({ port, close } = await startSftpServer(root, { username: "bstw", password: "s3cret" }));
});

afterAll(async () => {
  await close();
  fs.rmSync(root, { recursive: true, force: true });
});
describe("SFTP transport", () => {
  it("connects with a password, lists the inbox, reads a file, writes via a temp name and renames, makes done/", async () => {
    const box = await openSftp({ enabled: true, host: "127.0.0.1", port, username: "bstw", password: "s3cret", inbox: "/in", outbox: "/out" });
    try {
      const inbox = await box.list("/in");
      expect(inbox.map((f) => f.name)).toEqual(["RXO_204.edi"]);
      expect(inbox[0].size).toBe(12);
      expect(await box.get("/in/RXO_204.edi")).toBe("ISA*00*test~");
      await box.put("/out/.997_BSTW_1.edi.part", "ISA*00*997~");
      await box.rename("/out/.997_BSTW_1.edi.part", "/out/997_BSTW_1.edi");
      expect(fs.readFileSync(path.join(root, "out", "997_BSTW_1.edi"), "utf8")).toBe("ISA*00*997~");
      expect(fs.existsSync(path.join(root, "out", ".997_BSTW_1.edi.part"))).toBe(false);
      await box.mkdir("/in/done");
      await box.mkdir("/in/done"); // idempotent
      await box.rename("/in/RXO_204.edi", "/in/done/RXO_204.edi");
      expect((await box.list("/in")).map((f) => `${f.name}${f.isDir ? "/" : ""}`)).toEqual(["done/"]);
      expect(fs.existsSync(path.join(root, "in", "done", "RXO_204.edi"))).toBe(true);
      await expect(box.get("/in/nope.edi")).rejects.toThrow();
    } finally {
      await box.end();
    }
  });

  it("a wrong password or a dead port is refused, not hung", async () => {
    await expect(openSftp({ enabled: true, host: "127.0.0.1", port, username: "bstw", password: "wrong", inbox: "/in", outbox: "/out" })).rejects.toThrow(/auth|All configured authentication methods failed/i);
    await expect(openSftp({ enabled: true, host: "127.0.0.1", port: 1, username: "bstw", password: "s3cret", inbox: "/in", outbox: "/out" })).rejects.toThrow();
  }, 20_000);

  it("memory box mirrors the transport contract; file filter and validation", async () => {
    const box = memoryBox({ "/in/a.edi": "x", "/in/sub/b.edi": "y" });
    expect((await box.list("/in")).map((f) => `${f.name}${f.isDir ? "/" : ""}`).sort()).toEqual(["a.edi", "sub/"]);
    await box.mkdir("/in/done");
    expect((await box.list("/in")).some((f) => f.name === "done" && f.isDir)).toBe(true);
    expect(isInterchangeFile(".hidden", 10)).toBe(false);
    expect(isInterchangeFile("x.ok", 10)).toBe(false);
    expect(isInterchangeFile("x.edi", 0)).toBe(false);
    expect(isInterchangeFile("RXO_204.edi", 500)).toBe(true);
    expect(validateMailbox({ host: "h", username: "u", password: "p", inbox: "/i", outbox: "/o", port: 22 })).toBeNull();
    expect(validateMailbox({ host: "h", username: "u", password: "p", inbox: "/i", outbox: "/o", port: 70000 })).toMatch(/port/);
    expect(validateMailbox({ host: "", username: "u", password: "p", inbox: "/i", outbox: "/o" })).toMatch(/host/);
  });
});
