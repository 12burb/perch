import { describe, expect, test } from "bun:test";
import { decodeTunnelFrame, encodeTunnelFrame, type TunnelFrame } from "../src/http-tunnel.ts";

/**
 * Task 1.19 (spec §7.6 `http.open`): the tunnel's frames. A stream carries text, an HTTP body does
 * not, and a preview serves plenty of images — so the one thing this must never do is mangle bytes.
 */

function roundTrip(frame: TunnelFrame): TunnelFrame | null {
  return decodeTunnelFrame(encodeTunnelFrame(frame));
}

describe("the preview tunnel's frames", () => {
  test("bytes survive, whatever they are", () => {
    const data = new Uint8Array([0, 255, 127, 128, 10, 13, 34, 92, 159, 146, 150]);
    const back = roundTrip({ kind: "bytes", data });
    expect(back?.kind).toBe("bytes");
    expect([...(back as { data: Uint8Array }).data]).toEqual([...data]);

    // Bigger than the chunk the encoder splits at, so the split itself is exercised.
    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const large = roundTrip({ kind: "bytes", data: big }) as { data: Uint8Array };
    expect(large.data.byteLength).toBe(big.byteLength);
    expect([...large.data.subarray(19_990)]).toEqual([...big.subarray(19_990)]);

    expect(roundTrip({ kind: "bytes", data: new Uint8Array(0) })).toEqual({
      kind: "bytes",
      data: new Uint8Array(0),
    });
  });

  test("text keeps its colons, newlines and unicode", () => {
    const text = 'a:b\nc: {"vite":"hmr"} 🕊';
    expect(roundTrip({ kind: "text", text })).toEqual({ kind: "text", text });
  });

  test("a response head keeps its status, reason and repeated headers", () => {
    const frame: TunnelFrame = {
      kind: "head",
      status: 206,
      statusText: "Partial Content",
      headers: [
        ["content-type", "text/html"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
    };
    expect(roundTrip(frame)).toEqual(frame);
  });

  test("open, end, close and error", () => {
    expect(roundTrip({ kind: "open", protocol: "vite-hmr" })).toEqual({
      kind: "open",
      protocol: "vite-hmr",
    });
    expect(roundTrip({ kind: "end" })).toEqual({ kind: "end" });
    expect(roundTrip({ kind: "close", code: 1001, reason: "going away" })).toEqual({
      kind: "close",
      code: 1001,
      reason: "going away",
    });
    expect(roundTrip({ kind: "error", message: "connection refused" })).toEqual({
      kind: "error",
      message: "connection refused",
    });
  });

  test("a frame this side cannot read is dropped, not guessed at", () => {
    expect(decodeTunnelFrame("")).toBeNull();
    expect(decodeTunnelFrame("nonsense")).toBeNull();
    expect(decodeTunnelFrame("z:whatever")).toBeNull();
    expect(decodeTunnelFrame("h:not json")).toBeNull();
    expect(decodeTunnelFrame("h:{}")).toBeNull();
  });

  test("a head is checked field by field before a Response is built from it", () => {
    const head = (status: unknown, headers: unknown) =>
      decodeTunnelFrame(`h:${JSON.stringify({ status, statusText: "", headers })}`);
    // A Response carries an integer status from 200 to 599; anything else would throw in the api.
    expect(head(200, [])).toEqual({ kind: "head", status: 200, statusText: "", headers: [] });
    expect(head(599, [["x-a", "1"]])).toMatchObject({ status: 599, headers: [["x-a", "1"]] });
    expect(head(199, [])).toBeNull();
    expect(head(600, [])).toBeNull();
    expect(head(200.5, [])).toBeNull();
    expect(head("200", [])).toBeNull();
    // Every header is a pair of strings, or the head is not one.
    expect(head(200, [["x-a"]])).toBeNull();
    expect(head(200, [["x-a", 1]])).toBeNull();
    expect(head(200, [[1, "x"]])).toBeNull();
    expect(head(200, ["x-a: 1"])).toBeNull();
    expect(head(200, [["x-a", "1", "2"]])).toBeNull();
    expect(head(200, { "x-a": "1" })).toBeNull();
    expect(head(200, null)).toBeNull();
    // A status text of the wrong shape is dropped, not the head.
    expect(
      decodeTunnelFrame(`h:${JSON.stringify({ status: 204, statusText: 7, headers: [] })}`),
    ).toEqual({ kind: "head", status: 204, statusText: "", headers: [] });
    // A close with nothing in it still means closed, on the default code.
    expect(decodeTunnelFrame("c:{}")).toEqual({ kind: "close", code: 1000, reason: "" });
  });
});
