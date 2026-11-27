import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { prefetchAutoImport } from "@/features/settings/AutoImportSection";
import { useAuthStore } from "@/stores/auth";
import "./styles/app.css";

// 清理同源下历史遗留的 Service Worker，杜绝旧壳拦截新构建分包
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => undefined);
}
if ("caches" in window) {
  void window.caches
    .keys()
    .then((keys) => Promise.all(keys.map((k) => window.caches.delete(k))))
    .catch(() => undefined);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

// 登录态就绪后（管理员）提前预取“书源自动导入”数据，进用户管理页秒开
function AutoImportPrefetch() {
  const user = useAuthStore((s) => s.user);
  const initialized = useAuthStore((s) => s.initialized);
  useEffect(() => {
    if (initialized && user?.isAdmin) void prefetchAutoImport();
  }, [initialized, user]);
  return null;
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <App />
          <AutoImportPrefetch />
        </BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
