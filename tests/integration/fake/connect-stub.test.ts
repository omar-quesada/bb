import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const loopback = "127.0.0.1";
const apiPath = "/api/v1/threads";
const sendPath = `${apiPath}/example/send`;
const receivedSends: string[] = [];

async function listen(server: Server): Promise<number> {
  server.listen(0, loopback);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("mobile Connect stub fixtures", () => {
  let upstream: Server;
  let stub: ChildProcess | undefined;
  let certDir: string;
  let ca: Buffer;
  let gatePort: number;
  let controlPort: number;

  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === sendPath) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        receivedSends.push(Buffer.concat(chunks).toString());
      }
      res.end("upstream reached");
    });
    const upstreamPort = await listen(upstream);
    const gateReservation = createServer();
    const controlReservation = createServer();
    gatePort = await listen(gateReservation);
    controlPort = await listen(controlReservation);
    await Promise.all([close(gateReservation), close(controlReservation)]);
    certDir = await mkdtemp(join(tmpdir(), "bb-connect-stub-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("../mobile-e2e/connect-stub.ts", import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          BB_MOBILE_E2E_GATE_PORT: String(gatePort),
          BB_MOBILE_E2E_STUB_CONTROL_PORT: String(controlPort),
          BB_MOBILE_E2E_UPSTREAM_URL: `http://${loopback}:${upstreamPort}`,
          BB_MOBILE_E2E_STUB_CERT_DIR: certDir,
          BB_MOBILE_E2E_SIMULATOR: "",
          BB_MOBILE_E2E_CONNECT_CODE: "STUB-PAIR",
          BB_MOBILE_E2E_STUB_HANDLE: "stub",
        },
      },
    );
    stub = child;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error(`Connect stub exited: ${stderr}`);
      }),
    ]);
    ca = await readFile(join(certDir, "ca.pem"));
  });

  afterAll(async () => {
    if (stub && stub.exitCode === null && stub.signalCode === null) {
      const exited = once(stub, "exit");
      stub.kill();
      await exited;
    }
    if (upstream?.listening) await close(upstream);
    if (certDir) await rm(certDir, { recursive: true, force: true });
  });

  async function arm(action: string): Promise<void> {
    const response = await fetch(
      `http://${loopback}:${controlPort}/__stub/${action}`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await response.text();
  }

  function gate(
    path: string,
    {
      method = "GET",
      headers,
      body,
    }: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<{ status: number | undefined; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: loopback,
          servername: "localhost",
          port: gatePort,
          ca,
          path,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  async function redeem(code = "STUB-PAIR") {
    return gate("/api/connect/redeem-machine", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  it("rejects one authenticated API call without invalidating the session or credential", async () => {
    const { credential } = JSON.parse((await redeem()).body);
    const machine = { "x-bb-connect-machine": credential };
    const mint = () =>
      gate("/api/connect/desktop-session", {
        method: "POST",
        headers: machine,
      });
    const { cookie } = JSON.parse((await mint()).body);
    const headers = { cookie: `${cookie.name}=${cookie.value}` };

    await arm("next-api-401");
    expect((await gate(apiPath)).status).toBe(401);
    expect((await gate(apiPath, { headers })).status).toBe(401);
    expect((await gate(apiPath, { headers })).status).toBe(200);
    expect((await mint()).status).toBe(200);

    await arm("next-api-401");
    expect((await gate(apiPath, { headers: machine })).status).toBe(401);
    expect((await gate(apiPath, { headers: machine })).status).toBe(200);
  });

  it("changes only the next successful redeem's handle and server URL", async () => {
    const defaultOwner = {
      handle: "stub",
      serverUrl: `https://stub.localhost:${gatePort}`,
    };
    expect(JSON.parse((await redeem()).body)).toMatchObject(defaultOwner);

    await arm("next-redeem-different-owner");
    expect((await redeem("EXPIRED-CODE")).status).toBe(410);
    expect(JSON.parse((await redeem()).body)).toMatchObject({
      handle: "other",
      serverUrl: `https://other.localhost:${gatePort}`,
    });
    expect(JSON.parse((await redeem()).body)).toMatchObject(defaultOwner);

    await arm("next-redeem-missing-owner");
    expect(JSON.parse((await redeem()).body)).toMatchObject({
      handle: null,
      serverUrl: null,
    });
    expect(JSON.parse((await redeem()).body)).toMatchObject(defaultOwner);
  });

  it("forwards one send body and drops the response without forwarding unrelated requests twice", async () => {
    const { credential } = JSON.parse((await redeem()).body);
    const headers = { "x-bb-connect-machine": credential };
    await arm("drop-next-send-response");
    expect((await gate(apiPath, { headers })).status).toBe(200);
    expect((await gate(sendPath, { headers })).status).toBe(200);
    const send = (body: string) =>
      gate(sendPath, { method: "POST", headers, body });
    await expect(send("first send")).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(receivedSends).toEqual(["first send"]);
    expect(await send("second send")).toEqual({
      status: 200,
      body: "upstream reached",
    });
    expect(receivedSends).toEqual(["first send", "second send"]);
  });
});
