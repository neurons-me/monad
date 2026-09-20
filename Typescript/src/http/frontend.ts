import express from "express";
import path from "node:path";

/**
 * Serves the FILES of a built front end (its /assets, images, fonts) as they
 * are. index.html is not served from here: the shell hands it out for browser
 * requests to any route, with the namespace injected (see shell.ts), and
 * everything else keeps answering NRP. So a request only lands here when it
 * names a file that exists in the directory; anything else falls through.
 *
 * No directory index and no trailing-slash redirect: `/users` must stay an NRP
 * read even if a folder of that name were ever in the bundle.
 */
export function createFrontendStatic(dir: string): express.RequestHandler {
  return express.static(dir, {
    index: false,
    redirect: false,
    fallthrough: true,
    dotfiles: "ignore",
    setHeaders(res, filePath) {
      // Build output names its assets by content hash: safe to keep forever.
      // Anything else (icons, fonts at a fixed name) is re-checked.
      const hashed = filePath.split(path.sep).includes("assets");
      res.setHeader("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
}
