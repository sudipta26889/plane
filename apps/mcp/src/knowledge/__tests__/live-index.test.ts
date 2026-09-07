import { describe, it, expect } from "vitest";
import { parseNotification, CHANNEL } from "../live-index.js";

describe("parseNotification", () => {
  it("accepts a well-formed work item notification", () => {
    expect(parseNotification('{"entity":"work_item","id":"abc-123"}')).toEqual({
      entity: "work_item",
      id: "abc-123",
    });
  });

  it("accepts a page notification", () => {
    expect(parseNotification('{"entity":"page","id":"p-1"}')).toEqual({ entity: "page", id: "p-1" });
  });

  it("rejects an unknown entity rather than indexing the wrong corpus", () => {
    expect(parseNotification('{"entity":"comment","id":"c-1"}')).toBeNull();
  });

  it("rejects a missing or empty id", () => {
    expect(parseNotification('{"entity":"page"}')).toBeNull();
    expect(parseNotification('{"entity":"page","id":""}')).toBeNull();
    expect(parseNotification('{"entity":"page","id":42}')).toBeNull();
  });

  it("survives malformed JSON instead of taking the listener down", () => {
    // A bad payload from a trigger must not kill the listener: losing it would
    // silently return the system to ten-minute staleness with nothing to show why.
    expect(parseNotification("not json at all")).toBeNull();
    expect(parseNotification("")).toBeNull();
    expect(parseNotification(undefined)).toBeNull();
  });

  it("uses the channel the trigger publishes to", () => {
    // If these drift, notifications are emitted into the void and the only
    // symptom is silent staleness.
    expect(CHANNEL).toBe("taskpilot_index");
  });
});
