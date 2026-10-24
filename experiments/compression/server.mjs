import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.dirname(
  fileURLToPath(import.meta.resolve("@noble/hashes/sha2.js")),
);
const sourceNames = new Set(["core", "client", "worker"]);
export async function serve(port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      let body, type;
      if (url.pathname === "/") {
        body = await fs.readFile(path.join(root, "harness.html"));
        type = "text/html";
      } else if (/^\/vendor\/[a-zA-Z0-9_-]+\.js$/.test(url.pathname)) {
        body = await fs.readFile(
          path.join(vendor, path.basename(url.pathname)),
        );
        type = "text/javascript";
      } else {
        const name = url.pathname.match(/^\/([a-z]+)\.js$/)?.[1];
        if (!sourceNames.has(name)) {
          res.writeHead(404).end();
          return;
        }
        const source = await fs.readFile(path.join(root, `${name}.ts`), "utf8");
        body = ts
          .transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
            },
          })
          .outputText.replaceAll('"@noble/hashes/', '"/vendor/');
        type = "text/javascript";
      }
      res
        .writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(body);
    } catch {
      res.writeHead(500).end("Harness resource unavailable");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(3201);
  console.log(url);
}
