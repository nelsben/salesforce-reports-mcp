import { bundleHost, viewHtml } from "./host-page.js";

/** Bundle the host for the browser once, and fail early when the server is not built, for both views. */
export default async function globalSetup(): Promise<void> {
  await viewHtml("report");
  await viewHtml("dashboard");
  await bundleHost();
}
