"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getProvider, getProviderCapabilities } = require("../server/providers/registry");

test("LinkedIn provider publishes a member text post using the versioned Posts API", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:test-post" } });
  };
  process.env.LINKEDIN_API_VERSION = "202611";

  const result = await getProvider("LinkedIn").publish({
    post: { body: "A human-approved update." },
    token: "provider-token",
    subject: "member-123",
  });

  assert.equal(captured.url, "https://api.linkedin.com/rest/posts");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer provider-token");
  assert.equal(captured.options.headers["Linkedin-Version"], "202611");
  assert.equal(captured.options.headers["X-Restli-Protocol-Version"], "2.0.0");
  assert.deepEqual(JSON.parse(captured.options.body), {
    author: "urn:li:person:member-123",
    commentary: "A human-approved update.",
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
  assert.deepEqual(result, { remoteId: "urn:li:share:test-post", detail: "Published to LinkedIn." });
});

test("provider explicitly refuses unsupported platform publishing", async () => {
  await assert.rejects(
    getProvider("Instagram").publish({ post: { body: "No credentials" }, token: "", subject: "" }),
    /Instagram publishing is not configured/,
  );
});

test("provider capability registry leaves unsupported integrations disabled", () => {
  const capabilities = getProviderCapabilities();
  assert.equal(capabilities.LinkedIn.publishing, true);
  assert.equal(capabilities.LinkedIn.analytics, false);
  assert.equal(capabilities.Facebook.publishing, false);
  assert.equal(capabilities.X.publishing, false);
});
