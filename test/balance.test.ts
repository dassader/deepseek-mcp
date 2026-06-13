import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekAccountBalanceError, getDeepSeekAccountBalance } from "../mcp/deepseek/balance.js";

test("getDeepSeekAccountBalance reads user balance without exposing the API key", async () => {
  const oldFetch = globalThis.fetch;
  let authorizationHeader = "";
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    authorizationHeader = headers.get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "12.34",
            granted_balance: "2.00",
            topped_up_balance: "10.34",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const balance = await getDeepSeekAccountBalance({ apiKey: "secret-key", baseUrl: "https://api.deepseek.test" });

    assert.equal(authorizationHeader, "Bearer secret-key");
    assert.equal(balance.isAvailable, true);
    assert.deepEqual(balance.balanceInfos, [
      {
        currency: "USD",
        totalBalance: "12.34",
        grantedBalance: "2.00",
        toppedUpBalance: "10.34",
      },
    ]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("getDeepSeekAccountBalance reports DeepSeek balance HTTP errors with status code", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad key", { status: 401 });

  try {
    await assert.rejects(() => getDeepSeekAccountBalance({ apiKey: "bad-key" }), (error: unknown) => {
      assert.ok(error instanceof DeepSeekAccountBalanceError);
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /DeepSeek balance HTTP 401/);
      return true;
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
