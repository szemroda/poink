import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

export async function writeFileData(
  path: string,
  data: ArrayBuffer | ArrayBufferView | string,
): Promise<void> {
  const payload =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : typeof data === "string"
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(path, payload);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface FetchServer {
  stop: (force?: boolean) => void;
}

export interface ServeFetchOptions {
  hostname: string;
  port: number;
  fetch: FetchHandler;
}

function requestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1";
  return `http://${host}${req.url ?? "/"}`;
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.append(name, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    }
  }
  return headers;
}

function toWebRequest(req: IncomingMessage): Request {
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(req),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = req as unknown as BodyInit;
    init.duplex = "half";
  }

  return new Request(requestUrl(req), init);
}

async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

export async function serveFetch(
  options: ServeFetchOptions,
): Promise<FetchServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const response = await options.fetch(toWebRequest(req));
        await writeWebResponse(res, response);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain");
        }
        res.end(String(error));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.hostname);
  });

  return {
    stop: (force = false) => {
      if (force) server.closeAllConnections();
      server.close();
    },
  };
}
