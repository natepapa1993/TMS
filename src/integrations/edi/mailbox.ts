import SftpClient from "ssh2-sftp-client";
import type { EdiMailbox } from "@/db/schema";

/**
 * A VAN mailbox over SFTP (spec Phase 3 "EDI VAN"). Every VAN (Kleinschmidt, TrueCommerce, Loren Data…) and
 * most AS2 gateways expose an SFTP drop: we read their files from an inbox directory and write ours to an
 * outbox directory. The transport is an interface so the domain is tested against an in-memory box and the
 * SFTP implementation against a real in-process SSH server.
 */
export type Box = {
  list(dir: string): Promise<{ name: string; size: number; isDir: boolean }[]>;
  get(path: string): Promise<string>;
  put(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  end(): Promise<void>;
};

export type BoxOpener = (m: EdiMailbox) => Promise<Box>;

export function validateMailbox(m: Partial<EdiMailbox>): string | null {
  if (!m.host?.trim()) return "host is required";
  if (!m.username?.trim()) return "username is required";
  if (!m.password && !m.privateKey) return "a password or a private key is required";
  if (!m.inbox?.trim()) return "inbox directory is required";
  if (!m.outbox?.trim()) return "outbox directory is required";
  const port = Number(m.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be 1–65535";
  return null;
}

/** Open the real thing. Fails fast: 10 s to connect. */
export const openSftp: BoxOpener = async (m) => {
  const c = new SftpClient();
  await c.connect({ host: m.host, port: m.port || 22, username: m.username, password: m.password || undefined, privateKey: m.privateKey || undefined, readyTimeout: 10_000, retries: 0 });
  return {
    async list(dir) {
      const rows = await c.list(dir);
      return rows.map((r) => ({ name: r.name, size: r.size, isDir: r.type === "d" }));
    },
    async get(path) {
      const buf = await c.get(path);
      return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    },
    async put(path, text) {
      await c.put(Buffer.from(text, "utf8"), path);
    },
    async rename(from, to) {
      await c.rename(from, to);
    },
    async mkdir(dir) {
      if (!(await c.exists(dir))) await c.mkdir(dir, true);
    },
    async end() {
      await c.end();
    },
  };
};

/** An in-memory box for tests and previews: a flat map of path → text. */
export function memoryBox(files: Record<string, string> = {}): Box & { files: Record<string, string> } {
  const norm = (p: string) => p.replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  const dirs = new Set<string>();
  return {
    files,
    async list(dir) {
      const d = norm(dir) + "/";
      const seen = new Map<string, { name: string; size: number; isDir: boolean }>();
      for (const [p, t] of Object.entries(files)) {
        if (!p.startsWith(d)) continue;
        const rest = p.slice(d.length);
        const name = rest.split("/")[0];
        if (rest.includes("/")) seen.set(name, { name, size: 0, isDir: true });
        else seen.set(name, { name, size: Buffer.byteLength(t), isDir: false });
      }
      for (const x of dirs) if (x.startsWith(d) && !x.slice(d.length).includes("/")) seen.set(x.slice(d.length), { name: x.slice(d.length), size: 0, isDir: true });
      return [...seen.values()];
    },
    async get(path) {
      if (!(norm(path) in files)) throw new Error(`no such file: ${path}`);
      return files[norm(path)];
    },
    async put(path, text) {
      files[norm(path)] = text;
    },
    async rename(from, to) {
      if (!(norm(from) in files)) throw new Error(`no such file: ${from}`);
      files[norm(to)] = files[norm(from)];
      delete files[norm(from)];
    },
    async mkdir(dir) {
      dirs.add(norm(dir));
    },
    async end() {},
  };
}

/** Files a VAN drops that are not interchanges (receipts, .ok markers, directories) are left alone. */
export const isInterchangeFile = (name: string, size: number) => !name.startsWith(".") && size > 0 && size < 5_000_000 && !/\.(ok|tmp|part|filepart|lock)$/i.test(name);
