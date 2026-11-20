import { test, expect } from "bun:test";
import { extractMessages } from "./cc-capture.js";

// Build realistic high-entropy secret-shaped values at runtime from short
// fragments so no secret-looking literal sits in the source file.
const FAKE_OPENAI_KEY = [
  "sk",
  "-proj-",
  "Hj8kLp2QmN9vXyT4w",
  "RfB6cAeZgU3oIiKdS",
  "nJ7hMlPqWxCvFtYbEr",
].join("");

const FAKE_GH_TOKEN = [
  "ghp",
  "_",
  "9kR2mLxQ7pTvN4wY",
  "bF8sJhAeUiK3oXcZ",
  "gD6nR2mLxQ7pT",
].join("");

test("extractMessages redacts secret-shaped values in user and assistant messages", async () => {
  const transcript = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: "Please check " + "OPENAI_API_KEY=" + FAKE_OPENAI_KEY + " in the config",
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "text", text: "Found token " + FAKE_GH_TOKEN + " in your env." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
  ].join("\n");

  const messages = await extractMessages(transcript);
  expect(messages.length).toBe(2);

  expect(messages[0].role).toBe("user");
  expect(messages[0].content.includes(FAKE_OPENAI_KEY)).toBe(false);
  expect(messages[0].content.includes("[REDACTED]")).toBe(true);
  expect(messages[0].content.includes("OPENAI_API_KEY=")).toBe(true);

  expect(messages[1].role).toBe("assistant");
  expect(messages[1].model).toBe("claude-sonnet-4-6");
  expect(messages[1].content.includes(FAKE_GH_TOKEN)).toBe(false);
  expect(messages[1].content.includes("[REDACTED]")).toBe(true);
});

test("extractMessages passes ordinary text through unchanged", async () => {
  const userText = "How do we run the migration tests locally?";
  const assistantText = "Run bun test with IRA_TEST_DATABASE_URL pointed at ira_memory_test.";
  const transcript = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: userText },
    }),
    JSON.stringify({
      type: "result",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: assistantText }],
      },
    }),
  ].join("\n");

  const messages = await extractMessages(transcript);
  expect(messages).toEqual([
    {
      role: "user",
      content: userText,
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      role: "assistant",
      content: assistantText,
      model: "claude-opus-4-6",
      timestamp: "2026-01-01T00:00:02.000Z",
    },
  ]);
});

test("extractMessages skips malformed JSONL lines and non-message entries", async () => {
  const transcript = [
    "{malformed json line",
    "",
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "First valid message" },
    }),
    "not-json-at-all",
    JSON.stringify({
      type: "system",
      message: { role: "system", content: "ignored system entry" },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Second valid message" },
    }),
  ].join("\n");

  const messages = await extractMessages(transcript);
  expect(messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
    { role: "user", content: "First valid message" },
    { role: "assistant", content: "Second valid message" },
  ]);
});
