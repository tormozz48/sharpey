import { describe, expect, it } from "vitest";
import { appName } from "./index.js";

describe("web placeholder", () => {
  it("exports an app name string", () => {
    expect(typeof appName).toBe("string");
    expect(appName).toContain("sharpey-web");
  });
});
