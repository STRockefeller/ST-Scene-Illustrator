# Scene Illustrator for SillyTavern

[English](../README.md) | **繁體中文**

一個以「場景理解與視覺連續性」為核心的 SillyTavern 1.18.0+ 圖像生成 extension。它沿用官方 Image Generation 的 ComfyUI、Automatic1111、Google、OpenAI 等後端設定，補上場景挑選、角色外觀狀態、提示詞檢查、多張候選與段落內嵌。

## 安裝

1. 確認 SillyTavern 已更新至 1.18.0 或更新版本。
2. 將本 repository 放到 `SillyTavern/data/<你的使用者>/extensions/scene-illustrator`，或把 Git repository URL 貼進「Extensions → Install Extension」。
3. 重新載入 SillyTavern。
4. 在官方 Image Generation 面板設定並測試 ComfyUI 或其他圖像後端。
5. 在 Scene Illustrator 設定中選擇分析模型、提示詞風格與候選數量。

## 使用方式

- AI 訊息的動作選單會出現魔杖按鈕；按下後分析該回應的 1–3 個場景。
- 在訊息中反白文字後，按「依選取內容生成」建立單一場景。
- 在 extension 設定面板按「完全手動」，或使用 `/scene-image your prompt`。
- 工作台會先展示 direct 與 booru prompt。編輯確認後才會依序呼叫官方 `/imagine`。
- 每個場景選定一張候選圖，再按「插入已選圖片」。選中圖會歸檔到角色 Gallery，並以帶識別標記的 Markdown 寫入原回應；編輯回應時可直接看見和調整圖片連結。未選候選的暫存檔會自動刪除。

## 分析模型

- 「目前聊天模型」使用 SillyTavern 原生 structured generation。
- 「Connection Profile」可使用獨立的 Chat Completion 或 Text Completion profile；金鑰仍由 SillyTavern 管理。
- 無效、過短或格式錯誤的分析結果會自動修復一次，仍不合格則停止而不送出圖像請求。

## 角色狀態

extension 會在聊天 metadata 維護髮型、衣著、傷勢、配件等視覺快照。設定面板的「角色狀態」可在 AI 分析前手動新增角色，也可為每位角色新增任意自訂欄位、重新命名、刪除或鎖定資訊。重設後，下次分析會從角色卡、persona、tracker metadata、畫面上可見的 tracker 文字、啟用的 World Info 與目標訊息前文重建。角色狀態缺失或損壞不會阻止場景生成。

## Slash commands

- `/scene-image [prompt]`：開啟手動工作台。
- `/scene-analyze`：分析最近一則 AI 回應。

## 開發與測試

```powershell
node --check index.js
node --test
```

目前的自動測試涵蓋中英文段落、JSON 修復解析、過短提示詞、手動角色與自訂欄位、損壞狀態 fallback、長對話／tracker context、角色欄位鎖定、slash command escaping、設定 migration，以及鏡頭可見性規則。

## 已知界線

- 同一場景的候選圖會以同一份凍結 Prompt 並行批次提交；不同場景仍依序處理，避免一次塞入過多工作。
- 「取消後續生成」會停止後續場景；已提交的同場景批次可由官方 Image Generation 的取消提示停止。
- 新圖片直接存在回應 Markdown 中；手動刪除 Markdown 圖片後，metadata 仍保留時會暫時用相容模式顯示，直到下次重新儲存場景。

## 授權

本專案採用 [MIT License](../LICENSE) 授權。
