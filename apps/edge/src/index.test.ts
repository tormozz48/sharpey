import { describe, expect, it } from "vitest";
import worker from "./index.js";

describe("edge worker", () => {
  it("responds with a plaintext greeting", async () => {
    const response = worker.fetch(new Request("https://example.test/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^sharpey edge v/);
  });
});
