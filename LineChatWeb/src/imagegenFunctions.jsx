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
]
