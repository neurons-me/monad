import { Router, type Router as ExpressRouter } from "express";
import { createEnvelope, createErrorEnvelope } from "../http/envelope.js";
import { normalizeHttpRequestToMeTarget } from "../http/meTarget.js";

function parseHttpFetchUrl(value: unknown): URL | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

export type FetchSurfaceConfig = {
  timeoutMs: number;
};

export function createFetchSurface(config: FetchSurfaceConfig): ExpressRouter {
  const router = Router();

  router.get("/__fetch", async (req, res) => {
    const target = normalizeHttpRequestToMeTarget(req);
    const remoteUrl = parseHttpFetchUrl((req.query as any)?.url);

    if (!remoteUrl) {
      return res.status(400).json(createErrorEnvelope(target, {
        error: "FETCH_URL_INVALID",
        detail: "Provide an absolute http(s) URL via ?url=",
      }));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(remoteUrl.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": "monad.ai/1.0 this.DOM fetch proxy",
        },
      });

      const contentType = String(response.headers.get("content-type") || "text/html; charset=utf-8");
      const bodyText = await response.text();

      return res.status(response.status).json(createEnvelope(target, {
        value: {
          url: remoteUrl.toString(),
          finalUrl: response.url || remoteUrl.toString(),
          status: response.status,
          ok: response.ok,
          contentType,
          body: bodyText,
        },
      }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof Error && error.name === "AbortError";
      return res.status(isTimeout ? 504 : 502).json(createErrorEnvelope(target, {
        error: isTimeout ? "FETCH_TIMEOUT" : "FETCH_PROXY_FAILED",
        detail,
        value: { url: remoteUrl.toString() },
      }));
    } finally {
      clearTimeout(timeoutId);
    }
  });

  return router;
}
