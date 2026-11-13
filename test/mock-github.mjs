// 試験用のGitHubもどき（Contents APIのGETとPUTだけ）。recipes/ の中身を最初に読み込む。
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = new Map(); // path -> raw
const sha = (raw) => { const b = Buffer.from(raw); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const p of [...walk("recipes"), ...walk("masters")]) files.set(p, readFileSync(p, "utf8"));
const commits = [];

http.createServer((req, res) => {
  const m = req.url.match(/^\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/);
  if (!m) { res.writeHead(404).end(); return; }
  const path = decodeURI(m[1]);
  if (req.method === "GET") {
    if (!files.has(path)) { res.writeHead(404).end("{}"); return; }
    const raw = files.get(path);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ content: Buffer.from(raw).toString("base64"), sha: sha(raw) }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    const exists = files.has(path);
    if (!j.sha && exists) { res.writeHead(422).end('{"message":"sha wasn\'t supplied"}'); return; }
    if (j.sha && (!exists || sha(files.get(path)) !== j.sha)) { res.writeHead(409).end('{"message":"sha mismatch"}'); return; }
    const raw = Buffer.from(j.content, "base64").toString("utf8");
    files.set(path, raw);
    commits.push({ path, message: j.message });
    writeFileSync("test/out-commits.json", JSON.stringify(commits, null, 2));
    writeFileSync(`test/out-${path.replace(/\//g, "__")}`, raw);
    res.writeHead(exists ? 200 : 201, { "Content-Type": "application/json" })
      .end(JSON.stringify({ content: { sha: sha(raw) }, commit: { html_url: `mock://commit/${commits.length}` } }));
  });
}).listen(8788, () => console.log("mock github on :8788"));
