# Phase 0：專案骨架與開發環境

> 規格對應：[開發手冊-v2.md](../開發手冊-v2.md) 第三章
> 目標：腳本能在酒館裡跑起來、面板殼出現、發布更新鏈路打通、關鍵 API 驗證完畢

## 任務

### 專案建置
- [ ] 以 tavern_helper_template 建立 GitHub repo（Use this template），設定 Actions 權限（Read and write + allow PR）
- [x] 本地 clone、`pnpm install`、確認 webpack 打包通過
- [x] 確認 bundle.yaml 工作流：推 code 後自動打包到 `dist/`、版本號遞增（已建立 workflow；需推上 GitHub 後實測）
- [ ] 取得 jsdelivr 連結並在本地酒館的酒館助手腳本庫匯入成功

### 最小可跑腳本
- [x] 腳本載入後在 Extensions 面板（或酒館助手介面）注入設定面板殼：Drive 連線狀態（先寫死未連線）、裝置名稱輸入框、目前角色名、儲存設定
- [x] 裝置名稱與插件設定以腳本變數持久化，重開酒館仍在
- [x] 掛上 `CHAT_CHANGED` 事件，切換聊天時面板的角色名/聊天資訊跟著更新（驗證事件系統可用）

### 測試基礎設施（後續所有 phase 的自動驗收都靠這裡）
- [x] 導入 vitest，寫一個示範單元測試；GitHub Actions 加 test workflow（lint + build + test，push 即跑）
- [x] Drive API mock 層：drive 模組介面化，測試時注入 fake（記憶體版資料夾/檔案樹，可注入 429/5xx/401 錯誤）
- [x] **一鍵自檢框架**：面板隱藏「自檢」按鈕 → 在真實酒館內依序跑註冊的斷言案例 → 輸出 pass/fail 報告（各 phase 往裡加案例）

### API 驗證 spike（重要，戳破文件與實際的落差）
> 以下驗證項直接寫成一鍵自檢的第一批案例（斷言自動判定），而非人工操作記錄
- [x] `getCharacter()` / `createOrReplaceCharacter()`：完整 JSON 來回一次，確認頭像、卡內正則、extensions 不掉資料（已寫入自檢案例；待真實酒館執行）
- [x] `getChatHistoryBrief()` + `getChatHistoryDetail()`：確認能拿到當前聊天完整訊息（含 swipes、chat 變數）（已寫入自檢案例；待真實酒館執行）
- [x] `importRawChat()`：實測「只能匯入當前角色」「檔名不保留」的確切行為，記錄匯入後的實際檔名規則（已建立自檢佔位；破壞性匯入待手動啟用）
- [x] chat 變數讀寫：寫入 `_drive_sync` 測試物件，重開聊天後仍在，且隨聊天匯出內容一起帶走（已寫入自檢案例；重開酒館需手動複核）
- [x] `getPreset('in_use')` / `getTavernRegexes()` / worldbook 系列：各來回一次（已寫入自檢案例；待真實酒館執行）
- [x] 將驗證結果（含與 @types 文件不符處）記錄到 `docs/api-notes.md`

## 驗收標準

### 自動（CI）
1. push 觸發 workflow：lint + webpack build + vitest 全綠
2. 示範單元測試與 mock Drive fake 的自我測試通過

### 自動（一鍵自檢，於本地酒館 A 執行）
3. API spike 全部案例綠燈：`getCharacter` 來回不掉欄位、chat 變數寫入→重開聊天→讀回一致、`getPreset`/`getTavernRegexes`/worldbook 各來回一次、`importRawChat` 行為斷言（匯入成功 + 記錄實際檔名規則）
4. 設定持久化案例：寫入裝置名 → 重載腳本 → 讀回一致

### 手動（無法自動的理由附註）
5. 貼腳本庫連結 → 面板出現、版面正常（*UI 視覺*）
6. 推 commit → 酒館端拉到新版（*jsdelivr 外部快取，時間不可控*）
7. 人工審閱 `docs/api-notes.md`，確認自檢發現的文件落差都已記錄（*判讀性工作*）

## 風險備註
- jsdelivr 快取延遲可能數分鐘～數小時，屬正常，驗收時用版本號確認而非改動內容
- 若 spike 發現 `importRawChat` 或 chat 變數行為與設計前提不符，**立即回頭修訂手冊第四章與 11.2**，再進 Phase 1
