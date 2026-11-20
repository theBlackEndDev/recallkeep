/**
 * ira-memory HTTP client.
 *
 * `global.fetch` is replaced with a fake for the duration of each check, then
 * restored, so these tests never touch the network or the real service.
 */

import {
	health,
	listFacts,
	searchFacts,
	recallHistory,
	syncSession,
	recentMessages,
	saveFact,
	writeHandoff,
} from "./client.ts";

let pass = 0, fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const realFetch = globalThis.fetch;

/** Install a fake fetch, run `fn`, restore the real fetch, return the result. */
async function withFetch<T>(
	fake: typeof fetch,
	fn: () => Promise<T>,
): Promise<T> {
	globalThis.fetch = fake;
	try {
		return await fn();
	} finally {
		globalThis.fetch = realFetch;
	}
}

function okResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
	} as Response;
}

function errorResponse(status: number, body: unknown): Response {
	return {
		ok: false,
		status,
		json: async () => body,
	} as Response;
}

function malformedResponse(): Response {
	return {
		ok: true,
		status: 200,
		json: async () => {
			throw new SyntaxError("Unexpected end of JSON input");
		},
	} as Response;
}

/** A fetch that never resolves until its AbortSignal fires, then rejects —
 * mirrors what `AbortSignal.timeout(800)` does against a hung request. */
function hangingFetch(): typeof fetch {
	return (async (_url: RequestInfo | URL, init?: RequestInit) => {
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			signal?.addEventListener("abort", () => {
				reject(new DOMException("The operation was aborted.", "TimeoutError"));
			});
		});
	}) as typeof fetch;
}

// --- syncSession: request shape ---

await withFetch(
	(async (url: RequestInfo | URL, init?: RequestInit) => {
		check("syncSession URL", String(url), "http://127.0.0.1:7775/session/sync");
		check("syncSession method", init?.method, "POST");
		check(
			"syncSession body",
			JSON.parse(init?.body as string),
			{ sessionFile: "/workspace/dev/.pi/agent/sessions/x/y.jsonl", sessionId: "sid1", cwd: "/workspace/dev/Projects/ira-memory", final: false },
		);
		return okResponse({ accepted: true });
	}) as typeof fetch,
	async () => {
		const result = await syncSession("/workspace/dev/.pi/agent/sessions/x/y.jsonl", "sid1", "/workspace/dev/Projects/ira-memory");
		check("syncSession result", result, { accepted: true });
	},
);

await withFetch(
	(async (_url: RequestInfo | URL, init?: RequestInit) => {
		check(
			"syncSession final:true is carried through",
			JSON.parse(init?.body as string).final,
			true,
		);
		return okResponse({ accepted: true });
	}) as typeof fetch,
	async () => {
		await syncSession("/workspace/dev/.pi/agent/sessions/x/y.jsonl", "sid1", "/workspace/dev/Projects/ira-memory", true);
	},
);

// --- writeHandoff: request shape ---

await withFetch(
	(async (url: RequestInfo | URL, init?: RequestInit) => {
		check("writeHandoff URL", String(url), "http://127.0.0.1:7775/memory");
		check("writeHandoff method", init?.method, "POST");
		check(
			"writeHandoff body",
			JSON.parse(init?.body as string),
			{
				content: "worked on X",
				type: "project",
				tags: ["project:ira-memory", "pi:handoff"],
			},
		);
		return okResponse({
			id: "f1",
			name: null,
			type: "project",
			description: null,
			content: "worked on X",
			category: "PROJECT_STATE",
			tier: "LONG_TERM",
			tags: ["project:ira-memory", "pi:handoff"],
			created_at: "2026-01-01T00:00:00.000Z",
		});
	}) as typeof fetch,
	async () => {
		const result = await writeHandoff("project:ira-memory", "worked on X");
		check("writeHandoff result id", result?.id, "f1");
	},
);

// --- listFacts: request shape ---

await withFetch(
	(async (url: RequestInfo | URL) => {
		check(
			"listFacts URL",
			String(url),
			"http://127.0.0.1:7775/memory/list?project=ira-memory&limit=25",
		);
		return okResponse({ facts: [{ id: "f1" }], total: 1 });
	}) as typeof fetch,
	async () => {
		const facts = await listFacts("ira-memory", 25);
		check("listFacts result length", facts.length, 1);
	},
);

// --- recentMessages: request shape ---

await withFetch(
	(async (url: RequestInfo | URL) => {
		check(
			"recentMessages URL",
			String(url),
			"http://127.0.0.1:7775/conversation/recent?channel=pi%3Aira-memory&limit=10",
		);
		return okResponse({ messages: [{ id: "m1" }] });
	}) as typeof fetch,
	async () => {
		const messages = await recentMessages("pi:ira-memory", 10);
		check("recentMessages result length", messages.length, 1);
	},
);

// --- health: request shape ---

await withFetch(
	(async (url: RequestInfo | URL) => {
		check("health URL", String(url), "http://127.0.0.1:7775/health");
		return okResponse({ status: "ok", backend: "ira-memory", port: 7775 });
	}) as typeof fetch,
	async () => {
		const result = await health();
		check("health result", result, { status: "ok", backend: "ira-memory", port: 7775 });
	},
);

// --- failure modes: each function returns null/[] rather than throwing ---

await withFetch(hangingFetch(), async () => {
	check("syncSession on timeout returns null", await syncSession("/f.jsonl", "sid", "/x"), null);
});

await withFetch(hangingFetch(), async () => {
	check("writeHandoff on timeout returns null", await writeHandoff("project:x", "c"), null);
});

await withFetch(hangingFetch(), async () => {
	check("listFacts on timeout returns []", await listFacts("x", 10), []);
});

await withFetch(hangingFetch(), async () => {
	check("recentMessages on timeout returns []", await recentMessages("pi:x", 10), []);
});

await withFetch(hangingFetch(), async () => {
	check("health on timeout returns null", await health(), null);
});

await withFetch(
	(async () => errorResponse(500, { error: "boom" })) as typeof fetch,
	async () => {
		check("syncSession on 500 returns null", await syncSession("/f.jsonl", "sid", "/x"), null);
	},
);

await withFetch(
	(async () => errorResponse(500, { error: "boom" })) as typeof fetch,
	async () => {
		check("listFacts on 500 returns []", await listFacts("x", 10), []);
	},
);

await withFetch(
	(async () => errorResponse(500, { error: "boom" })) as typeof fetch,
	async () => {
		check("health on 500 returns null", await health(), null);
	},
);

await withFetch(
	(async () => malformedResponse()) as typeof fetch,
	async () => {
		check("syncSession on malformed JSON returns null", await syncSession("/f.jsonl", "sid", "/x"), null);
	},
);

await withFetch(
	(async () => malformedResponse()) as typeof fetch,
	async () => {
		check("listFacts on malformed JSON returns []", await listFacts("x", 10), []);
	},
);

await withFetch(
	(async () => malformedResponse()) as typeof fetch,
	async () => {
		check("recentMessages on malformed JSON returns []", await recentMessages("pi:x", 10), []);
	},
);

// searchFacts / recallHistory: "all" (or omitted) project must drop the ?project=
// query param entirely, since the server treats a missing param as unscoped —
// sending project=all literally would filter for a fact tagged "project:all".
let capturedUrl = "";
const urlSpy = (async (input: string) => {
	capturedUrl = input;
	return okResponse({ facts: [], messages: [] });
}) as typeof fetch;

await withFetch(urlSpy, async () => {
	await searchFacts("q", "all", 10);
	check("searchFacts('all') omits project param", capturedUrl.includes("project="), false);
});

await withFetch(urlSpy, async () => {
	await searchFacts("q", undefined, 10);
	check("searchFacts(undefined) omits project param", capturedUrl.includes("project="), false);
});

await withFetch(urlSpy, async () => {
	await searchFacts("q", "my-project", 10);
	check("searchFacts('my-project') scopes to that project", capturedUrl.includes("project=my-project"), true);
});

await withFetch(urlSpy, async () => {
	await recallHistory("q", "all", 10);
	check("recallHistory('all') omits project param", capturedUrl.includes("project="), false);
});

await withFetch(urlSpy, async () => {
	await recallHistory("q", "my-project", 10);
	check("recallHistory('my-project') scopes to that project", capturedUrl.includes("project=my-project"), true);
});


// --- saveFact: request shape, project goes through the server's field ---

await withFetch(
	(async (url: RequestInfo | URL, init?: RequestInit) => {
		check("saveFact URL", String(url), "http://127.0.0.1:7775/memory");
		check("saveFact method", init?.method, "POST");
		check("saveFact body", JSON.parse(init?.body as string), {
			content: "Money in args is integer cents",
			type: "project",
			project: "billing-api",
			tags: ["decision"],
		});
		return okResponse({ id: "f9", tags: ["friday:project", "project:billing-api", "decision"], content: "[billing-api] Money in args is integer cents" });
	}) as typeof fetch,
	async () => {
		const fact = await saveFact({ content: "Money in args is integer cents", type: "project", project: "billing-api", tags: ["decision"] });
		check("saveFact returns the stored fact", fact?.id, "f9");
	},
);

await withFetch(
	(async (_url: RequestInfo | URL, init?: RequestInit) => {
		check("saveFact without tags sends []", JSON.parse(init?.body as string).tags, []);
		return { ok: false, status: 400, json: async () => ({ error: "content required" }) } as Response;
	}) as typeof fetch,
	async () => {
		check("saveFact on non-2xx is null", await saveFact({ content: "x", type: "user", project: "global" }), null);
	},
);

await withFetch(
	(async () => {
		throw new Error("ECONNREFUSED");
	}) as typeof fetch,
	async () => {
		check("saveFact when the service is down is null", await saveFact({ content: "x", type: "user", project: "global" }), null);
	},
);

// --- IRA_API_TOKEN: bearer header sent when set, absent otherwise ---

const prevToken = process.env.IRA_API_TOKEN;
process.env.IRA_API_TOKEN = "test-token";
await withFetch(
	(async (_url: RequestInfo | URL, init?: RequestInit) => {
		const headers = init?.headers as Record<string, string>;
		check("bearer header sent when IRA_API_TOKEN is set", headers?.Authorization, "Bearer test-token");
		return okResponse({ status: "ok", backend: "ira-memory", port: 7775 });
	}) as typeof fetch,
	async () => {
		await health();
		await writeHandoff("project:x", "c"); // headers merge with Content-Type
	},
);
await withFetch(
	(async (_url: RequestInfo | URL, init?: RequestInit) => {
		const headers = init?.headers as Record<string, string>;
		check("bearer header keeps Content-Type on POST", headers?.["Content-Type"], "application/json");
		return okResponse({});
	}) as typeof fetch,
	async () => {
		await writeHandoff("project:x", "c");
	},
);
delete process.env.IRA_API_TOKEN;
await withFetch(
	(async (_url: RequestInfo | URL, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		check("no Authorization header when IRA_API_TOKEN is unset", headers.Authorization, undefined);
		return okResponse({});
	}) as typeof fetch,
	async () => {
		await health();
	},
);
if (prevToken !== undefined) process.env.IRA_API_TOKEN = prevToken;

console.log(`\n${pass} passed, ${fail} failed`);
// Only exit on failure: exiting 0 here would kill the shared bun process before
// any sibling test file in the same `bun test` run had a chance to load.
if (fail) process.exit(1);
