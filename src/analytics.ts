import posthog from "posthog-js";

posthog.init("phc_u9sEREoykrDKErEtysyiAiRTRAEDcfKxE5y6HQcFsWMn", {
  api_host: "https://us.i.posthog.com",
  person_profiles: "identified_only",
  capture_pageview: true,
  capture_pageleave: true,
});

export function track(event: string, props?: Record<string, unknown>): void {
  posthog.capture(event, props);
}
