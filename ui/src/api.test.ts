import { test, expect } from "bun:test";
import { api, onTrouble, onVersion, streamTiming, type Trouble } from "@/api";
import { clearToken, storeToken, token } from "@/token";

/**
 * What every request owes the server — the token in a header, nothing cached, no
 * token in any URL — and what the stream reader does with a body that arrives in
 * pieces, goes silent, or ends.
 */

type Reply = (url: string, init?: RequestInit) => Promise<Response>;

/** Runs `body` with fetch replaced, and always puts the real one back. */
async function withFetch(reply: Reply, body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    reply(String(input), init)) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

/** Puts the stream's clocks back, so one test cannot shorten the next one's. */
function restoreTiming() {
  streamTiming.retryMs = 1000;
  streamTiming.idleMs = 30_000;
}

const json = (v: unknown) =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const status = (code: number) =>
  new Response(JSON.stringify({ error: "no" }), { status: code });

test("a read and a write carry the token in a header, cache nothing, and never in the URL", async () => {
  storeToken("a-token");
  const sent: { url: string; token: string | null; cache: string | undefined }[] = [];
  await withFetch(
    async (url, init) => {
      sent.push({
        url,
        token: new Headers(init?.headers).get("X-Wikiview-Token"),
        cache: init?.cache,
      });
      return json({});
    },
    async () => {
      await api.bundle();
      await api.setCheckbox("/notes/a.md", 6, true, 3);
    },
  );
  expect(sent.map((s) => s.token)).toEqual(["a-token", "a-token"]);
  expect(sent.map((s) => s.cache)).toEqual(["no-store", "no-store"]);
  // The token is a header on /api and never anywhere in the address.
  expect(sent.every((s) => !s.url.includes("a-token"))).toBe(true);
});

test("with no token the header says `local`, which a localhost server accepts", async () => {
  clearToken();
  const sent: (string | null)[] = [];
  await withFetch(
    async (_url, init) => {
      sent.push(new Headers(init?.headers).get("X-Wikiview-Token"));
      return json({});
    },
    async () => {
      await api.bundle();
    },
  );
  expect(sent).toEqual(["local"]);
});

test("the stream reports the versions the server writes, across seams and heartbeats", async () => {
  storeToken("a-token");
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const got: number[] = [];

  await withFetch(
    async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    async () => {
      const unsubscribe = onVersion((v) => got.push(v));
      try {
        const send = (s: string) => controller?.enqueue(new TextEncoder().encode(s));
        // A writer and a reader are not in step, so an event can arrive split in
        // two: the reader has to hold the tail rather than drop the event.
        send("event: vers");
        send("ion\ndata: 7");
        send("\n\n");
        // The heartbeat is a comment, and not every event is a version.
        send(": heartbeat\n\n");
        send("event: keepalive\ndata: 0\n\n");
        // No data is not version 0.
        send("event: version\n\n");
        // CRLF is what a proxy may hand over.
        send("event: version\r\ndata: 12\r\n\r\n");
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        unsubscribe();
      }
    },
  );
  expect(got).toEqual([7, 12]);
});

test("a 401 reports the refused token and drops it", async () => {
  storeToken("a-token");
  const trouble: Trouble[] = [];
  const stop = onTrouble((reason) => trouble.push(reason));
  try {
    await withFetch(
      async () => status(401),
      async () => {
        await api.bundle().catch(() => {});
      },
    );
  } finally {
    stop();
  }
  expect(trouble).toEqual(["token-refused"]);
  expect(token()).toBeNull();
});

test("a 421 reports the address and keeps the token", async () => {
  storeToken("a-token");
  const trouble: Trouble[] = [];
  const stop = onTrouble((reason) => trouble.push(reason));
  try {
    await withFetch(
      async () => status(421),
      async () => {
        await api.bundle().catch(() => {});
      },
    );
  } finally {
    stop();
  }
  expect(trouble).toEqual(["host-refused"]);
  // The token was never the problem, so the printed address still works.
  expect(token()).toBe("a-token");
});

test("a server that never answers ends the retries and says it is unreachable", async () => {
  storeToken("a-token");
  const trouble: Trouble[] = [];
  const stop = onTrouble((reason) => trouble.push(reason));
  try {
    // A 1ms first wait instead of a second, so the budget can be watched running
    // out without the test waiting fifteen seconds for it.
    streamTiming.retryMs = 1;
    let attempts = 0;
    await withFetch(
      async () => {
        attempts++;
        return status(503);
      },
      async () => {
        const unsubscribeStream = onVersion(() => {});
        try {
          await new Promise((r) => setTimeout(r, 80));
        } finally {
          unsubscribeStream();
        }
      },
    );
    // One try, then the retry budget: four more, and then it stops.
    expect(attempts).toBe(5);
  } finally {
    stop();
    restoreTiming();
  }
  expect(trouble).toEqual(["unreachable"]);
});

test("a stream that goes silent is aborted and retried", async () => {
  storeToken("a-token");
  const trouble: Trouble[] = [];
  const stop = onTrouble((reason) => trouble.push(reason));
  try {
    // A 20ms idle deadline and quick retries: the point is that a body which
    // never delivers and never ends is not waited on forever.
    streamTiming.idleMs = 20;
    streamTiming.retryMs = 5;
    let opened = 0;
    await withFetch(
      async () => {
        opened++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Nothing, ever: a socket that died without closing.
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      async () => {
        const unsubscribe = onVersion(() => {});
        try {
          await new Promise((r) => setTimeout(r, 300));
        } finally {
          unsubscribe();
        }
      },
    );
    expect(opened).toBeGreaterThan(1);
  } finally {
    stop();
    restoreTiming();
  }
  // Every attempt was silent, so the budget ran out rather than hanging.
  expect(trouble).toEqual(["unreachable"]);
});

test("a 401 for a token the tab has since replaced keeps the new one", async () => {
  storeToken("old-token");
  const trouble: Trouble[] = [];
  const stop = onTrouble((reason) => trouble.push(reason));
  try {
    await withFetch(
      async () => {
        // The user pastes the newly printed link while this request is out.
        storeToken("new-token");
        return status(401);
      },
      async () => {
        await api.bundle().catch(() => {});
      },
    );
  } finally {
    stop();
  }
  expect(token()).toBe("new-token");
  expect(trouble).toEqual([]);
});

test("a stream that only sends heartbeats stays open", async () => {
  storeToken("a-token");
  const trouble: Trouble[] = [];
  const stop = onTrouble((reason) => trouble.push(reason));
  let beat: ReturnType<typeof setInterval> | undefined;
  try {
    // Heartbeats every 10ms against a 150ms idle deadline, watched for 600ms:
    // each beat resets the clock, so the one connection is never aborted, and
    // a stall under load has 140ms of slack before it reads as silence.
    streamTiming.idleMs = 150;
    streamTiming.retryMs = 5;
    let opened = 0;
    await withFetch(
      async () => {
        opened++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const ping = new TextEncoder().encode(": ping\n\n");
              beat = setInterval(() => controller.enqueue(ping), 10);
            },
            cancel() {
              clearInterval(beat);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      async () => {
        const unsubscribe = onVersion(() => {});
        try {
          await new Promise((r) => setTimeout(r, 600));
        } finally {
          unsubscribe();
        }
      },
    );
    expect(opened).toBe(1);
  } finally {
    clearInterval(beat);
    stop();
    restoreTiming();
  }
  expect(trouble).toEqual([]);
});
