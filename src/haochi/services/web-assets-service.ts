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

  adminIndex() {
    const filePath = this.#resolveAdminFile("index.html");
    return new Response(fs.readFileSync(filePath), {
      type: "text/html",
      headers: {
        "Cache-Control": "no-cache",
      },
    });
  }

  adminAsset(fileName: string) {
    const filePath = this.#resolveAdminFile(fileName);
    return new Response(fs.readFileSync(filePath), {
      type: mime.getType(filePath) || "application/octet-stream",
      headers: {
        "Cache-Control": fileName.endsWith(".css") || fileName.endsWith(".js")
          ? "public, max-age=300"
          : "no-cache",
      },
    });
  }
}
