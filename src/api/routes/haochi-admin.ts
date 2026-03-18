import Request from "@/lib/request/Request.ts";
import SYSTEM_EX from "@/lib/consts/exceptions.ts";
import Exception from "@/lib/exceptions/Exception.ts";
import Response from "@/lib/response/Response.ts";
import { haochiAccountPoolService, haochiAdminAuthService } from "@/haochi/index.ts";
import AdminLogService from "@/haochi/services/admin-log-service.ts";
import { clampNumber } from "@/haochi/utils/crypto.ts";

const adminLogService = new AdminLogService();

function requireAdmin<T>(request: Request, handler: (auth: ReturnType<typeof haochiAdminAuthService.requireUser>) => Promise<T> | T) {
  const auth = haochiAdminAuthService.requireUser(request.headers.cookie);
  return handler(auth);
}

export default [
  {
    prefix: "/api/admin/auth",
    post: {
      "/login": async (request: Request) => {
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        if (!username || !password) {
          throw new Exception(SYSTEM_EX.SYSTEM_REQUEST_VALIDATION_ERROR, "用户名和密码不能为空").setHTTPStatusCode(400);
        }

        const { session, user } = haochiAdminAuthService.login(username, password);
        return new Response(
          {
            ok: true,
            user,
            expiresAt: session.expiresAt,
          },
          {
            headers: {
              "Set-Cookie": haochiAdminAuthService.buildSessionCookie(session.token),
            },
          }
        );
      },
      "/logout": async (request: Request) => {
        haochiAdminAuthService.logout(request.headers.cookie);
        return new Response(
          {
            ok: true,
          },
          {
            headers: {
              "Set-Cookie": haochiAdminAuthService.buildClearCookie(),
            },
          }
        );
      },
      "/change-password": async (request: Request) =>
        requireAdmin(request, async (auth) => {
          const currentPassword = String(request.body?.currentPassword || "");
          const nextPassword = String(request.body?.nextPassword || "");
          return haochiAdminAuthService.changePassword(
            auth.user.id,
            currentPassword,
            nextPassword
          );
        }),
    },
    get: {
      "/me": async (request: Request) => requireAdmin(request, (auth) => auth),
    },
  },
  {
    prefix: "/api/admin",
    get: {
      "/overview": async (request: Request) =>
        requireAdmin(request, async (auth) => ({
          user: auth.user,
          ...haochiAccountPoolService.getOverview(),
        })),
      "/accounts": async (request: Request) =>
        requireAdmin(request, async () => {
          const page = clampNumber(request.query?.page, 1, 9999, 1);
          const pageSize = clampNumber(request.query?.pageSize ?? request.query?.page_size, 1, 100, 10);
          return haochiAccountPoolService.listAccountsPage({
            page,
            pageSize,
            status: request.query?.status,
          });
        }),
      "/accounts/export": async (request: Request) =>
        requireAdmin(request, async () =>
          haochiAccountPoolService.exportAccounts({
            status: request.query?.status,
          })
        ),
      "/api-keys": async (request: Request) =>
        requireAdmin(request, async () => ({
          items: haochiAccountPoolService.listApiKeys(),
        })),
      "/logs/outbound": async (request: Request) =>
        requireAdmin(request, async () =>
          adminLogService.getOutboundLogs({
            date: String(request.query?.date || "").trim() || null,
            keyword: String(request.query?.keyword || "").trim() || null,
            limit: clampNumber(request.query?.limit, 1, 400, 120),
          })
        ),
    },
    post: {
      "/accounts": async (request: Request) =>
        requireAdmin(request, async () => ({
          item: haochiAccountPoolService.createAccount(request.body),
        })),
      "/accounts/batch/update": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.updateAccountsBatch(request.body)),
      "/accounts/batch/delete": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.deleteAccountsBatch(request.body)),
      "/accounts/batch/refresh-invalid-session": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.refreshInvalidAccountsSessions()),
      "/accounts/batch/validate-session": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.validateAllAccountsSessions()),
      "/accounts/import": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.importAccounts(request.body)),
      "/accounts/:id/refresh-session": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.refreshAccountSession(request.params.id)),
      "/accounts/:id/validate-session": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.validateAccountSession(request.params.id)),
      "/accounts/:id/blacklist": async (request: Request) =>
        requireAdmin(request, async () => ({
          item: haochiAccountPoolService.blacklistAccount(
            request.params.id,
            String(request.body?.reason || "手动拉黑").trim()
          ),
        })),
      "/accounts/:id/unblacklist": async (request: Request) =>
        requireAdmin(request, async () => ({
          item: haochiAccountPoolService.unblacklistAccount(request.params.id),
        })),
      "/api-keys": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.createApiKey(request.body)),
      "/api-keys/:id/rotate": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.rotateApiKey(request.params.id)),
    },
    put: {
      "/accounts/:id": async (request: Request) =>
        requireAdmin(request, async () => ({
          item: haochiAccountPoolService.updateAccount(request.params.id, request.body),
        })),
      "/api-keys/:id": async (request: Request) =>
        requireAdmin(request, async () => ({
          item: haochiAccountPoolService.updateApiKey(request.params.id, request.body),
        })),
    },
    delete: {
      "/accounts/:id": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.deleteAccount(request.params.id)),
      "/api-keys/:id": async (request: Request) =>
        requireAdmin(request, async () => haochiAccountPoolService.deleteApiKey(request.params.id)),
    },
  },
];
