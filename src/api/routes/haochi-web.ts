import Request from "@/lib/request/Request.ts";
import WebAssetsService from "@/haochi/services/web-assets-service.ts";

const webAssetsService = new WebAssetsService();

export default {
  get: {
    "/admin": async (_request: Request) => webAssetsService.adminIndex(),
    "/admin/": async (_request: Request) => webAssetsService.adminIndex(),
    "/admin/login": async (_request: Request) => webAssetsService.adminIndex(),
    "/admin/assets/:name": async (request: Request) =>
      webAssetsService.adminAsset(String(request.params.name || "")),
  },
};
