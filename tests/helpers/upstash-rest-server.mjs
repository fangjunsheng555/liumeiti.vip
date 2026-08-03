import http from "node:http";
import { spawnSync } from "node:child_process";

const container = process.env.TEST_REDIS_CONTAINER || "lm-ui-redis";
const token = process.env.TEST_REDIS_TOKEN || "local-test-token";
const port = Number(process.env.TEST_REDIS_HTTP_PORT || 8079);

function redis(command) {
  const child = spawnSync(
    "docker",
    ["exec", container, "redis-cli", "--json", ...command.map(String)],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis_command_failed");
  const output = child.stdout.trim();
  if (!output) return null;
  try { return JSON.parse(output); } catch { return output; }
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (request.method === "POST" && url.pathname === "/pipeline") {
      const commands = JSON.parse(await readBody(request));
      if (!Array.isArray(commands)) throw new Error("invalid_pipeline");
      json(response, 200, commands.map((command) => ({ result: redis(command) })));
      return;
    }
    if (request.method !== "GET") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }
    const command = url.pathname.split("/").slice(1).filter(Boolean).map(decodeURIComponent);
    if (!command.length) {
      json(response, 200, { result: "PONG" });
      return;
    }
    json(response, 200, { result: redis(command) });
  } catch (error) {
    json(response, 500, { error: String(error?.message || "redis_proxy_failed").slice(0, 500) });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`local_upstash_rest=http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
