import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // runModel does real hardware detection and file checksumming on its first call
    // in each test file; on a loaded CI runner that can exceed vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
