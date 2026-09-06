import { describe, it, expect } from "vitest";
import { parseSseJson, extractToolText } from "../longmemory.js";

describe("parseSseJson", () => {
  it("reads the JSON out of an SSE frame", () => {
    // The server answers `event: message` + `data: {...}`; a plain JSON.parse of
    // the whole body throws, which is how this integration fails silently.
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseSseJson(body)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("skips non-JSON data lines rather than giving up", () => {
    const body = "event: ping\ndata: keep-alive\nevent: message\ndata: {\"result\":{\"ok\":1}}\n";
    expect(parseSseJson(body)).toEqual({ result: { ok: 1 } });
  });

  it("returns null when there is no data frame at all", () => {
    expect(parseSseJson("event: message\n\n")).toBeNull();
    expect(parseSseJson("")).toBeNull();
  });
});

describe("extractToolText", () => {
  it("joins the text parts of a tool result", () => {
    const payload = { result: { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] } };
    expect(extractToolText(payload)).toBe("one\ntwo");
  });

  it("ignores non-text content instead of rendering undefined", () => {
    const payload = { result: { content: [{ type: "image" }, { type: "text", text: "kept" }] } };
    expect(extractToolText(payload)).toBe("kept");
  });

  it("returns an empty string for a malformed or empty result", () => {
    expect(extractToolText({ result: {} })).toBe("");
    expect(extractToolText({})).toBe("");
    expect(extractToolText(null)).toBe("");
  });
});
