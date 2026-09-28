import { Server, utils, type SFTPWrapper } from "ssh2";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A tiny SFTP server backed by a directory: enough of the protocol (OPENDIR/READDIR, OPEN/READ/WRITE/CLOSE,
 * RENAME, MKDIR, STAT/LSTAT, REALPATH) for the client library's list / get / put / rename / mkdir / exists.
 * Used by the unit test of the transport and by the browser test of the VAN mailbox screen.
 */
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
function serveSftp(root: string, sftp: SFTPWrapper) {
  const handles = new Map<number, { path: string; fd?: number; entries?: string[]; sent?: boolean }>();
  let next = 1;
  const abs = (p: string) => path.join(root, path.normalize("/" + p));
  const handle = (h: Buffer) => handles.get(h.readUInt32BE(0));
  const mk = (v: { path: string; fd?: number; entries?: string[] }) => {
    const id = next++;
    handles.set(id, v);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id, 0);
    return b;
  };
  const attrsOf = (p: string) => {
    const st = fs.statSync(p);
    return { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
  };
  sftp.on("REALPATH", (reqid, p) => sftp.name(reqid, [{ filename: path.posix.normalize("/" + p), longname: "", attrs: {} as never }]));
  sftp.on("STAT", (reqid, p) => (fs.existsSync(abs(p)) ? sftp.attrs(reqid, attrsOf(abs(p)) as never) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)));
  sftp.on("LSTAT", (reqid, p) => (fs.existsSync(abs(p)) ? sftp.attrs(reqid, attrsOf(abs(p)) as never) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)));
  sftp.on("OPENDIR", (reqid, p) => {
    if (!fs.existsSync(abs(p)) || !fs.statSync(abs(p)).isDirectory()) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    sftp.handle(reqid, mk({ path: abs(p), entries: fs.readdirSync(abs(p)) }));
  });
  sftp.on("READDIR", (reqid, h) => {
    const d = handle(h);
    if (!d?.entries) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (d.sent) return sftp.status(reqid, STATUS_CODE.EOF);
    d.sent = true;
    sftp.name(
      reqid,
      d.entries.map((name) => {
        const st = fs.statSync(path.join(d.path, name));
        return { filename: name, longname: `${st.isDirectory() ? "d" : "-"}rw-r--r--   1 van van ${st.size} Jan  1 00:00 ${name}`, attrs: attrsOf(path.join(d.path, name)) as never };
      }),
    );
  });
  sftp.on("OPEN", (reqid, p, flags) => {
    const write = !!(flags & OPEN_MODE.WRITE);
    try {
      const fd = fs.openSync(abs(p), write ? "w" : "r");
      sftp.handle(reqid, mk({ path: abs(p), fd }));
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });
  sftp.on("READ", (reqid, h, offset, length) => {
    const f = handle(h);
    if (!f || f.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(length);
    const n = fs.readSync(f.fd, buf, 0, length, Number(offset));
    if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, buf.subarray(0, n));
  });
  sftp.on("WRITE", (reqid, h, offset, data) => {
    const f = handle(h);
    if (!f || f.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.writeSync(f.fd, data, 0, data.length, Number(offset));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("FSTAT", (reqid, h) => {
    const f = handle(h);
    if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE);
    sftp.attrs(reqid, attrsOf(f.path) as never);
  });
  sftp.on("CLOSE", (reqid, h) => {
    const f = handle(h);
    if (f?.fd != null) fs.closeSync(f.fd);
    handles.delete(h.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("RENAME", (reqid, from, to) => {
    try {
      fs.renameSync(abs(from), abs(to));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });
  sftp.on("MKDIR", (reqid, p) => {
    try {
      fs.mkdirSync(abs(p), { recursive: true });
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });
  sftp.on("REMOVE", (reqid, p) => {
    try {
      fs.unlinkSync(abs(p));
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });
}


export async function startSftpServer(root: string, auth: { username: string; password: string }) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (a) => {
      if (a.method === "password" && a.username === auth.username && a.password === auth.password) return a.accept();
      a.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (accept) => serveSftp(root, accept()));
      });
    });
    client.on("error", () => null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
