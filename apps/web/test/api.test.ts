import { describe, expect, test } from "bun:test";
import { RequestFailed, unwrap } from "../src/lib/api.ts";

/** The client's one reading of an api answer: data, or a RequestFailed with what the api said. */

const response = (status: number) => new Response(null, { status });

describe("unwrap", () => {
  test("a success with no body (204) is a success, not 'request failed with 204' (A-wc-12)", () => {
    expect(() => unwrap({ data: undefined, response: response(204) })).not.toThrow();
    expect(unwrap({ data: undefined, response: response(204) })).toBeUndefined();
  });

  test("a success with a body hands the body back", () => {
    expect(unwrap({ data: { id: "x" }, response: response(200) })).toEqual({ id: "x" });
  });

  test("an error in the §7.8 shape carries its code, message, details and status", () => {
    const body = { error: { code: "conflict", message: "already there", details: { rule: "r" } } };
    try {
      unwrap({ error: body, response: response(409) });
      throw new Error("unwrap did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestFailed);
      const failed = error as RequestFailed;
      expect(failed.message).toBe("already there");
      expect(failed.code).toBe("conflict");
      expect(failed.status).toBe(409);
      expect(failed.details).toEqual({ rule: "r" });
    }
  });

  test("an error body that is not the §7.8 shape is still a RequestFailed with its status (A-wc-13)", () => {
    for (const body of [
      "<html>Bad Gateway</html>",
      "",
      { message: "nope" },
      { error: "x" },
      null,
    ]) {
      try {
        unwrap({ error: body, response: response(502) });
        throw new Error("unwrap did not throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RequestFailed);
        const failed = error as RequestFailed;
        expect(failed.status).toBe(502);
        expect(failed.code).toBe("internal");
        expect(failed.message).toBe("request failed with 502");
        expect(failed.details).toBeUndefined();
      }
    }
  });

  test("a failure with no body is a RequestFailed too", () => {
    expect(() => unwrap({ error: undefined, response: response(500) })).toThrow(
      "request failed with 500",
    );
  });
});
