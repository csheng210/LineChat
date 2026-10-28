// 生圖功能清單(三個 ComfyAPI 端點), 供 status bar 功能按鈕與生圖頁面共用。
export const FUNCTIONS = [
  {
    id: 'text2img',
    label: '純文生圖',
    desc: '輸入提示詞, 產出一張圖(預設 1024×1024)',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v18M3 12h18" />
      </svg>
    ),
  },
  {
    id: 'image1',
    label: '單圖編輯',
    desc: '一張圖 + 提示詞, 依原圖長寬產出新圖',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.5-3.5L9 20" />
      </svg>
    ),
  },
  {
    id: 'upscale',
    label: '放大圖片',
    desc: '一張圖, 放大輸出高解析度圖(依原圖自動放大)',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
      </svg>
    ),
  },
  {
    id: 'bgremove',
    label: '去背',
    desc: '一張圖, 去背後產出一張圖(依原圖長寬)',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 16a6 6 0 0 1 8-5.5A5 5 0 0 1 18 15a3 3 0 0 1 0 6H6a4 4 0 0 1-2-5z" />
        <path d="M4 20h16" />
      </svg>
    ),
  },
  {
    id: 'image2',
    label: '雙圖合成',
    desc: '兩張圖 + 提示詞, 輸出長寬依圖一',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="12" height="12" rx="2" />
        <rect x="9" y="9" width="12" height="12" rx="2" />
      </svg>
    ),
  },  {
    id: 'image2video',
    label: '圖生影片',
    desc: '一張圖 + 提示詞, 產出一段影片',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m10 9 5 3-5 3z" />
      </svg>
    ),
  },
  {
    id: 'images2video',
    label: '首尾圖生影片',
    desc: '首圖 + 尾圖 + 秒數, 產出一段影片',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M7 5v14M17 5v14" />
        <path d="m10 9 4 3-4 3z" />
      </svg>
    ),
  },
  {
    id: 'text2video',
    label: '文生影片',
    desc: '輸入提示詞, 產出一段影片(可設秒數與長寬)',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <path d="M7 3v18M17 3v18M2 8h5M2 16h5M17 8h5M17 16h5" />
      </svg>
    ),
  },
  {
    id: 'refmodeT2v',
    label: '參考模型-文生影片',
    desc: '選參考 MOD + 提示詞, 產出一段影片',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
        <path d="m17 4 1.5 1.5L21 3" />
      </svg>
    ),
  },
  {
    id: 'iv2v',
    label: '參考圖片-影片生影片',
    desc: '參考圖 + 來源影片, 換掉片中人物產出新影片',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m10 9 5 3-5 3z" />
        <circle cx="7" cy="8" r="2" />
      </svg>
    ),
  },
  {
    id: 'video2refmod',
    label: '参考影片-生模型参考',
    desc: '一段影片 → 抽取服务器端模型参考档(RefMod)',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="12" rx="2" />
        <path d="m9 7 4 2-4 2z" />
        <path d="M12 16v5M8 21h8" />
      </svg>
    ),
  },
  {
    id: 'reversePrompt',
    label: '反推提示詞',
    desc: '一張圖或一段影片 → 反推出一段提示詞',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 5h16M4 12h10M4 19h7" />
        <path d="m18 15 3 3-3 3" />
      </svg>
    ),
  },
  {
    id: 'queue',
    label: '伺服器伺列',
    desc: '檢視與管理執行中 / 排隊中的任務',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18M3 12h18M3 18h12" />
        <circle cx="18" cy="18" r="3" />
      </svg>
    ),
  },
  {
    id: 'outputs',
    label: '瀏覽伺服器檔案',
    desc: '瀏覽 ComfyUI 伺服器輸出目錄',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M8 13l2.5 2.5L16 10" />
      </svg>
    ),
  },
  {
    id: 'resources',
    label: '多媒體瀏覽',
    desc: '瀏覽 Resources 目錄: 影片 / 圖片 / 提示詞',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 5h18v14H3z" />
        <path d="m10 9 5 3-5 3z" />
        <path d="M3 9h18" />
      </svg>
    ),
  },
  {
    id: 'videoReport',
    label: '影片產出摘要',
    desc: '從 Resources 挑影片 → 依字幕產生摘要，存到提示詞目錄',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="12" rx="2" />
        <path d="m10 8 4 2-4 2z" />
        <path d="M6 20h12M9 23h6" />
      </svg>
    ),
  },
  {
    id: 'chat',
    label: '模型聊天',
    desc: '輸入文字問模型, 可儲存/載入聊天紀錄',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
]
