import path from "path";

import fs from "fs-extra";
import mime from "mime";

import Response from "@/lib/response/Response.ts";

export default class WebAssetsService {
  readonly adminDir = path.resolve("public/admin");

  #resolveAdminFile(fileName: string) {
    const safeName = path.basename(fileName);
    const resolved = path.resolve(this.adminDir, safeName);
    if (!resolved.startsWith(this.adminDir)) {
      throw new Error("非法资源路径");
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`资源不存在: ${safeName}`);
    }
    return resolved;
  }

  #buildAssetVersion(fileName: string) {
    const filePath = this.#resolveAdminFile(fileName);
    const stat = fs.statSync(filePath);
    return `${Math.trunc(stat.mtimeMs)}-${stat.size.toString(36)}`;
  }

  #injectAssetVersions(html: string) {
    return html.replace(
      /((?:href|src)=["'])(\/admin\/assets\/([^"']+))(["'])/g,
      (_match, prefix, assetPath, fileName, suffix) =>
        `${prefix}${assetPath}?v=${this.#buildAssetVersion(String(fileName || ""))}${suffix}`
    );
  }

  adminIndex() {
    const filePath = this.#resolveAdminFile("index.html");
    const html = fs.readFileSync(filePath, "utf8");
    return new Response(this.#injectAssetVersions(html), {
      type: "text/html",
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  adminAsset(fileName: string) {
    const filePath = this.#resolveAdminFile(fileName);
    return new Response(fs.readFileSync(filePath), {
      type: mime.getType(filePath) || "application/octet-stream",
      headers: {
        "Cache-Control": fileName.endsWith(".css") || fileName.endsWith(".js")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  }
}
