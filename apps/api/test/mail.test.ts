import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { generateMasterKey } from "@perch/vault";
import pino from "pino";
import { type Booted, boot } from "../src/boot.ts";
import { loadEnv } from "../src/env.ts";
import { createLogger } from "../src/logging.ts";
import { mailerFor } from "../src/mail.ts";
import { completeSetup } from "../src/services/setup.ts";
import { TEST_ADMIN } from "../src/testing.ts";

/**
 * PERCH_SMTP_URL (spec §8; review findings X-secu-14, A-co-13): invite and password-reset links go
 * out by mail when a mail server is configured, and in no case into a log line (spec §1.6).
 */

/** A mail server that accepts everything and keeps each message's DATA. */
function fakeSmtp() {
  const messages: string[] = [];
  type State = { buffer: string; inData: boolean };
  const server = Bun.listen<State>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", inData: false };
        socket.write("220 fake ESMTP\r\n");
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += chunk.toString();
        for (;;) {
          if (state.inData) {
            const end = state.buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            messages.push(state.buffer.slice(0, end));
            state.buffer = state.buffer.slice(end + 5);
            state.inData = false;
            socket.write("250 queued\r\n");
            continue;
          }
          const newline = state.buffer.indexOf("\r\n");
          if (newline < 0) return;
          const line = state.buffer.slice(0, newline);
          state.buffer = state.buffer.slice(newline + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO") socket.write("250-fake\r\n250 8BITMIME\r\n");
          else if (verb === "DATA") {
            state.inData = true;
            socket.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
            return;
          } else socket.write("250 ok\r\n");
        }
      },
    },
  });
  return { port: server.port, messages, stop: () => server.stop(true) };
}

/** Quoted-printable, undone: soft breaks joined and `=XX` escapes decoded. */
function decoded(raw: string): string {
  return raw
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

const BASE = "http://localhost:3000";
let booted: Booted;
let smtp: ReturnType<typeof fakeSmtp>;
const logs = capture();

beforeAll(async () => {
  smtp = fakeSmtp();
  const env = loadEnv({
    DATABASE_URL: "pglite://memory",
    PERCH_MASTER_KEY: generateMasterKey(),
    PERCH_LOG_LEVEL: "info",
    PERCH_DATA_DIR: "/tmp/perch-test-data",
    PERCH_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    PERCH_SMTP_FROM: "Perch <perch@example.test>",
    PERCH_DEMO_WORKSPACE: "off",
  });
  booted = await boot({ env, log: createLogger({ level: "info", destination: logs.stream }) });
  await completeSetup(
    { db: booted.db.db, bus: booted.bus, auth: booted.auth, publicUrl: env.publicUrl },
    { admin: TEST_ADMIN, workspace: { name: "Mail" }, publicUrl: env.publicUrl, telemetry: false },
  );
}, 60_000);

afterAll(async () => {
  await booted.close();
  smtp.stop();
});

describe("mail over PERCH_SMTP_URL", () => {
  test("a password reset is mailed, and the link is in no log line", async () => {
    const res = await booted.app.request(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_ADMIN.email, redirectTo: "/" }),
    });
    expect(res.status).toBe(200);
    const mail = decoded(
      await until(() => smtp.messages.find((one) => one.includes("Reset your Perch password"))),
    );
    expect(mail).toContain(`To: ${TEST_ADMIN.email}`);
    expect(mail).toContain("From: Perch <perch@example.test>");
    const token = /\/api\/auth\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail)?.[1] ?? "";
    expect(token.length).toBeGreaterThan(10);
    expect(logs.text()).toContain("password reset requested");
    expect(logs.text()).not.toContain(token);
  });

  test("an invite is mailed to the invitee, returned to the inviter, and in no log line", async () => {
    const signIn = await booted.app.request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }),
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .join("; ");
    const list = (await (
      await booted.app.request(`${BASE}/api/workspaces`, { headers: { cookie } })
    ).json()) as { workspaces: { id: string }[] };
    const ws = list.workspaces[0]?.id ?? "";
    const invited = await booted.app.request(`${BASE}/api/workspaces/${ws}/invites`, {
      method: "POST",
      headers: { origin: BASE, cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "kimi-mail@example.test", role: "member" }),
    });
    expect(invited.status).toBe(201);
    const { accept_url } = (await invited.json()) as { accept_url: string };
    const token = accept_url.split("/invite/")[1] ?? "";
    expect(token).not.toBe("");
    const mail = decoded(
      await until(() => smtp.messages.find((one) => one.includes("kimi-mail@example.test"))),
    );
    expect(mail).toContain(accept_url);
    // The preview route reads the token from the path; the request line records the pattern.
    await booted.app.request(`${BASE}/api/invites/${token}`);
    expect(logs.text()).toContain("invite created");
    expect(logs.text()).not.toContain(token);
  });
});

describe("without PERCH_SMTP_URL", () => {
  test("nothing is sent and the message, links and all, is not logged", async () => {
    const out = capture();
    const log = pino({ level: "info" }, out.stream);
    const mailer = mailerFor({ smtpUrl: undefined, smtpFrom: undefined, publicUrl: BASE }, log);
    expect(mailer.configured).toBe(false);
    const sent = await mailer.send({
      to: "x@example.test",
      subject: "Reset your Perch password",
      text: "open http://localhost:3000/api/auth/reset-password/secret-reset-token",
    });
    expect(sent).toBe(false);
    expect(out.text()).toContain("no mail server is configured");
    expect(out.text()).not.toContain("secret-reset-token");
  });
});
