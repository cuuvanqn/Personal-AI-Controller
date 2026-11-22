import { jsonResponse, errorResponse } from "./common";
import { matchDaemonRoute } from "./lcg-routes";

/**
 * PAC does not accept remote-vendor update checks or binary replacement.
 * Installing a reviewed, signed release will use a separate explicit workflow.
 */
export async function handleUpdateRoutes(req: Request, url: URL): Promise<Response | null> {
  if (matchDaemonRoute(url.pathname, "UPDATE_STATUS") && req.method === "GET") {
    return jsonResponse({
      enabled: false,
      updateAvailable: false,
      autoUpdateEnabled: false,
      reason: "PAC vendor updater disabled: use a reviewed release"
    });
  }
  if (matchDaemonRoute(url.pathname, "UPDATE_CHECK") && req.method === "POST") {
    return errorResponse("Vendor update checks are disabled in PAC", 403);
  }
  if (matchDaemonRoute(url.pathname, "UPDATE_APPLY") && req.method === "POST") {
    return errorResponse("Remote binary replacement is disabled in PAC", 403);
  }
  return null;
}
