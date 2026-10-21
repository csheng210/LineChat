# 反推提示詞 Custom Node (LinePromptReverse)

ComfyUI custom node：輸入圖片或影片（batch 影格），輸出反推提示詞字串。

## 重要：節點跑在 ComfyUI 伺服器自己的 Python 環境

本專案的 ComfyUI 是遠端 `http://svc.summer-blue.com:8188`（從 Comfy-Org/ComfyUI 手動安裝）。
Custom node 必須安裝到「那台 ComfyUI 主機」的 `custom_nodes/`，由它的 Python 執行，
不是跑在本機 `ComfyAPI/.venv`。

## 安裝

1. 把整個 `LinePromptReverse/` 資料夾複製到遠端 ComfyUI 的 `custom_nodes/` 下：
   `<ComfyUI>/custom_nodes/LinePromptReverse/`
2. 在該 ComfyUI 的 Python 環境安裝依賴（多數 ComfyUI 環境已內建）：
   ```
   pip install -r custom_nodes/LinePromptReverse/requirements.txt
   ```
3. 重啟 ComfyUI，節點分類 `LineChat/Prompt` 下會出現「反推提示詞 (Image/Video -> Prompt)」。

## 設定（base_url / model / api_key）

節點跑在遠端主機，讀不到本機 `ComfyAPI/.env`。設定有兩種來源：

- 節點上的輸入欄位 `base_url` / `model` / `api_key`（可直接在節點裡填）。
- 欄位預設值取自遠端主機的環境變數 `VTP_BASE_URL` / `VTP_MODEL` / `VTP_API_KEY`；
  未設定時退回內建預設（`http://svc.summer-blue.com:8189/v1`、`swift-1.5-iq3_xxs`、`llamacpp`）。

## 輸入 / 輸出

- 輸入 `image`：ComfyUI `IMAGE`。單張圖 = batch 1；影片 = 一批影格（例如 Load Video / VHS 節點輸出的影格 batch）。
- 輸出 `prompt`：`STRING`，反推出的提示詞（繁體中文）。
- `target`：選擇目標生圖/生影片模型預設（qwen-image / flux / sd / midjourney / dalle / veo / kling / runway / wan / hailuo），會附在請求裡讓提示詞風格貼近該模型。
- `max_frames`：影片最多抽幾張影格（單圖固定 1）。

## 依賴

`requests`、`Pillow`、`numpy`（ComfyUI 環境通常已內建）。不需要 `opencv`/ffmpeg，
影片在 ComfyUI 內就是一批 `IMAGE` 影格。
