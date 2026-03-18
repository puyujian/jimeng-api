import HaochiStateStore from "@/haochi/storage/state-store.ts";
import AdminAuthService from "@/haochi/services/admin-auth-service.ts";
import AccountPoolService from "@/haochi/services/account-pool-service.ts";
import { createLoginProvider } from "@/haochi/services/login-provider.ts";

export const haochiStateStore = new HaochiStateStore();
export const haochiAdminAuthService = new AdminAuthService(haochiStateStore);
export const haochiAccountPoolService = new AccountPoolService(
  haochiStateStore,
  createLoginProvider()
);

haochiAdminAuthService.ensureBootstrapAdmin();
haochiAccountPoolService.start();
