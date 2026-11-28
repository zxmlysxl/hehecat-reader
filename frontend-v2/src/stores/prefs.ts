import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { userConfigApi } from "@/api/endpoints";

export type PaperTheme = "paper" | "parchment" | "celadon" | "dark" | "system";
export type ReaderFont =
  | "serif"
  | "kai"
  | "oldsong"
  | "fangsong"
  | "sans"
  | "round"
  | "custom";
export type ReadLayout = "paged" | "scroll";
export type SpreadMode = "auto" | "single";
export type PageTurnMode = "curl" | "none";
export type TtsEngine = "browser" | "edge" | "http";

export interface PrefsState {
  theme: PaperTheme;
  fontFamily: ReaderFont;
  customFontFamily: string;
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  contentWidth: number;
  indentParagraph: boolean;
  readLayout: ReadLayout;
  spreadMode: SpreadMode;
  pageTurnMode: PageTurnMode;
  autoScrollSpeed: number;
  searchTimeout: number;
  searchHistory: string[];
  ttsEngine: TtsEngine;
  ttsVoice: string;
  ttsRate: number;
  ttsAutoNext: boolean;

  setTheme: (theme: PaperTheme) => void;
  setFontFamily: (font: ReaderFont) => void;
  setCustomFontFamily: (family: string) => void;
  setFontSize: (px: number) => void;
  setLineHeight: (lh: number) => void;
  setParagraphGap: (em: number) => void;
  setContentWidth: (em: number) => void;
  setIndentParagraph: (v: boolean) => void;
  setReadLayout: (layout: ReadLayout) => void;
  setSpreadMode: (spread: SpreadMode) => void;
  setPageTurnMode: (mode: PageTurnMode) => void;
  setAutoScrollSpeed: (speed: number) => void;
  setSearchTimeout: (sec: number) => void;
  addSearchHistory: (keyword: string) => void;
  removeSearchHistory: (keyword: string) => void;
  clearSearchHistory: () => void;
  setTtsEngine: (engine: TtsEngine) => void;
  setTtsVoice: (voice: string) => void;
  setTtsRate: (rate: number) => void;
  setTtsAutoNext: (v: boolean) => void;
  resetTypography: () => void;
}

export const TYPOGRAPHY_DEFAULTS = {
  fontFamily: "serif" as ReaderFont,
  customFontFamily: "",
  fontSize: 18,
  lineHeight: 1.85,
  paragraphGap: 0.8,
  contentWidth: 42,
  indentParagraph: true,
  readLayout: "paged" as ReadLayout,
  spreadMode: "auto" as SpreadMode,
  pageTurnMode: "curl" as PageTurnMode,
};

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      theme: "system",
      ...TYPOGRAPHY_DEFAULTS,
      autoScrollSpeed: 42,
      searchTimeout: 15,
      searchHistory: [],
      ttsEngine: "browser",
      ttsVoice: "",
      ttsRate: 1.0,
      ttsAutoNext: true,

      setTheme: (theme) => set({ theme }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setCustomFontFamily: (customFontFamily) => set({ customFontFamily }),
      setFontSize: (px) => set({ fontSize: Math.min(32, Math.max(14, Math.round(px))) }),
      setLineHeight: (lh) => set({ lineHeight: Math.min(2.4, Math.max(1.4, Math.round(lh * 20) / 20)) }),
      setParagraphGap: (em) => set({ paragraphGap: Math.min(1.8, Math.max(0.2, Math.round(em * 10) / 10)) }),
      setContentWidth: (em) => set({ contentWidth: Math.min(62, Math.max(32, Math.round(em))) }),
      setIndentParagraph: (indentParagraph) => set({ indentParagraph }),
      setReadLayout: (readLayout) => set({ readLayout }),
      setSpreadMode: (spreadMode) => set({ spreadMode }),
      setPageTurnMode: (pageTurnMode) => set({ pageTurnMode }),
      setAutoScrollSpeed: (s) => set({ autoScrollSpeed: Math.min(140, Math.max(12, Math.round(s))) }),
      setSearchTimeout: (sec) => set({ searchTimeout: Math.min(60, Math.max(3, Math.round(sec))) }),
      addSearchHistory: (keyword) =>
        set((s) => {
          const clean = keyword.trim();
          if (!clean) return s;
          return {
            searchHistory: [clean, ...s.searchHistory.filter((k) => k !== clean)].slice(0, 14),
          };
        }),
      removeSearchHistory: (keyword) =>
        set((s) => ({ searchHistory: s.searchHistory.filter((k) => k !== keyword) })),
      clearSearchHistory: () => set({ searchHistory: [] }),
      setTtsEngine: (ttsEngine) => set({ ttsEngine }),
      setTtsVoice: (ttsVoice) => set({ ttsVoice }),
      setTtsRate: (rate) => set({ ttsRate: Math.min(2.0, Math.max(0.6, Math.round(rate * 10) / 10)) }),
      setTtsAutoNext: (ttsAutoNext) => set({ ttsAutoNext }),
      resetTypography: () => set({ ...TYPOGRAPHY_DEFAULTS }),
    }),
    {
      name: "mojuan.prefs.v2",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // 服务端持久化：登录后从 /reader3/userConfig 拉取并合并，变更防抖回写
      onRehydrateStorage: () => (state) => {
        if (state) void syncFromServer(state);
      },
    },
  ),
);

const SYNCED_KEYS = [
  "theme",
  "fontFamily",
  "customFontFamily",
  "fontSize",
  "lineHeight",
  "paragraphGap",
  "contentWidth",
  "indentParagraph",
  "readLayout",
  "spreadMode",
  "pageTurnMode",
  "autoScrollSpeed",
  "searchTimeout",
  "ttsEngine",
  "ttsVoice",
  "ttsRate",
  "ttsAutoNext",
] as const;

/** 从服务端拉取配置并合并进 store（未登录/失败静默忽略） */
async function syncFromServer(current: PrefsState) {
  try {
    const remote = await userConfigApi.get();
    if (!remote || typeof remote !== "object") return;
    const patch: Record<string, unknown> = {};
    for (const k of SYNCED_KEYS) {
      if (k in remote) patch[k] = (remote as Record<string, unknown>)[k];
    }
    if (Object.keys(patch).length === 0) {
      // 服务端没有记录：把本地当前值推上去，作为该用户初始配置
      void pushToServer(current);
      return;
    }
    usePrefsStore.setState(patch as Partial<PrefsState>);
  } catch {
    /* 未登录或网络失败：保留本地设置 */
  }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** 防抖回写服务端（500ms），失败静默 */
function pushToServer(state: PrefsState) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const payload: Record<string, unknown> = {};
    for (const k of SYNCED_KEYS) payload[k] = state[k];
    void userConfigApi.save(payload).catch(() => {});
  }, 500);
}

let lastPushed: Partial<PrefsState> = usePrefsStore.getState();
usePrefsStore.subscribe((state) => {
  for (const k of SYNCED_KEYS) {
    if (state[k] !== lastPushed[k]) {
      lastPushed = state;
      pushToServer(state);
      return;
    }
  }
});

export function resolvePaperTheme(theme: PaperTheme): Exclude<PaperTheme, "system"> {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "paper";
}
