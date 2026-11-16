"use strict";

const providers = {
  LinkedIn: {
    canPublish: true,
    canReadAnalytics: false,
    async publish({ post, token, subject }) {
      const version = process.env.LINKEDIN_API_VERSION || "202611";
      const response = await fetch("https://api.linkedin.com/rest/posts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Linkedin-Version": version,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: `urn:li:person:${subject}`,
          commentary: post.body,
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.text();
      if (!response.ok) {
        console.error("LinkedIn post request failed.", response.status, body.slice(0, 500));
        throw new Error(response.status === 401 || response.status === 403
          ? "LinkedIn rejected the request. Reconnect the account and confirm w_member_social access is approved."
          : `LinkedIn publishing failed (HTTP ${response.status}). Check the account and API access.`);
      }
      return { remoteId: response.headers.get("x-restli-id"), detail: "Published to LinkedIn." };
    },
  },
};

function getProvider(platform) {
  return providers[platform] || {
    canPublish: false,
    canReadAnalytics: false,
    async publish() {
      throw new Error(`${platform} publishing is not configured yet. This post was not sent.`);
    },
  };
}

function getProviderCapabilities() {
  return {
    LinkedIn: { connected: Boolean(process.env.LINKEDIN_CLIENT_ID), publishing: true, analytics: false },
    Instagram: { connected: false, publishing: false, analytics: false },
    Facebook: { connected: false, publishing: false, analytics: false },
    X: { connected: false, publishing: false, analytics: false },
    GitHub: { connected: false, publishing: false, analytics: false },
    TikTok: { connected: false, publishing: false, analytics: false },
    YouTube: { connected: false, publishing: false, analytics: false },
  };
}

module.exports = { getProvider, getProviderCapabilities };
