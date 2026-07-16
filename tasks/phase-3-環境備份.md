# Phase 3：完整環境備份

> 規格對應：[開發手冊-v2.md](../開發手冊-v2.md) 5.1、第九章
> 前置：手冊第十六章待確認事項需已拿到客戶答案（群組排除、assets 延後影響本 phase 範圍）
> 目標：`[備份完整環境]` 一鍵把 5 個 item 成套上傳

## 任務

### 各 item 打包器（每個都含 pack 與格式驗證，還原留給 Phase 4）
- [ ] **character**：`getCharacter()` 完整 JSON；頭像 Blob 轉 base64 內嵌或依客戶選擇存 PNG 格式
- [ ] **world**：組 bundle `{ bindings: {chat, char_primary, char_additional, global_enabled}, books: {書名: 完整內容} }`——來源：`getChatWorldbookName` + `getCharWorldbookNames` + `getGlobalWorldbookNames` + 逐本 `getWorldbook`
- [ ] **persona**：`getPersona('current')` 完整內容，頭像 Blob 轉 base64 內嵌
- [ ] **preset**：`getPreset('in_use')` 快照，記錄來源預設名（`getLoadedPresetName()`）供還原時同名覆蓋
- [ ] **regex**：`getTavernRegexes({type:'global'})` 僅全域（角色/預設正則已含在各自 item，不重複）

### 備份流程（第九章）
- [ ] item 勾選 UI（預設全勾）
- [ ] 同一批備份共用同一個 UTC 時間戳（還原時可對成套）
- [ ] 逐 item 上傳至對應目錄，任一 item 失敗不中斷其他，最後彙總報告成功/失敗清單
- [ ] 各 item 的 keep_latest_n 清理（若啟用）

## 驗收標準

### 自動（CI）
1. 各 item 打包器輸出通過 zod schema 驗證（用固定 fixture 輸入）
2. regex 打包器只含全域正則（fixture 含三種 scope，斷言 character/preset scope 不在輸出）
3. world bundle：bindings 四欄齊全、books 含所有被綁定的書
4. 批次上傳（mock Drive）：同批共用同一時間戳；只勾 2 個 item 只上傳 2 個；注入單一 item 失敗 → 其餘完成、彙總報告標示正確
5. 各 item keep_latest_n 清理邏輯

### 自動（一鍵自檢，真實酒館 + 佈置好的測試環境）
> 自檢前置：一個「卡內正則 + 綁 2 本世界書 + 自訂 persona + 調過參數的預設 + 2 條全域正則」的測試聊天（佈置一次，重複使用）
6. 逐 item pack → schema 驗證 + 關鍵欄位斷言：character 含頭像與卡內正則、world bundle 的 books 數 = 綁定書數、preset 的 prompts 非空且含來源預設名、persona 含頭像
7. 走真實 Drive 完整備份一輪 → listVersions 斷言 5 個 item 目錄各出現同時間戳檔案 → download 回來與 pack 結果一致

### 手動（無法自動的理由附註）
8. 從 Drive 網頁端抽查下載檔案，對照酒館畫面確認內容語意正確（*schema 對了不代表內容對，語意判讀需人工*）
9. item 勾選 UI 操作體驗（*UI 視覺*）

## 風險備註
- 頭像/圖片內嵌 base64 會讓 JSON 變大，character 檔案預期 1–5MB，超過 5MB 走 Phase 1 的 resumable 上傳
- persona 的 connections 欄位指向角色/群組 id，跨裝置 id 未必一致——還原時 connections 僅盡力對應，Phase 4 處理時標記為已知限制
