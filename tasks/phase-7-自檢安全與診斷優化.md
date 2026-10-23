# Phase 7：自檢安全與診斷優化

> 前置：Phase 1–6 的 Drive、聊天同步、環境備份／還原與新版面板均已存在
> 目標：把目前混合在同一按鈕中的開發測試、環境健康檢查與破壞性驗證分層；預設自檢不得改動正式使用者資料，且每個失敗結果都要能指出下一步處理方式

## 現況問題

| 現況 | 風險／問題 | 決策 |
|---|---|---|
| `drive.mock.memory`、`chat.pack.roundtrip` 等純程式邏輯出現在產品自檢 | 與使用者環境無關，延長等待且幾乎固定通過 | 移至 CI |
| `api.chat.importRawChat` 永遠回傳 `skip` | 製造噪音，沒有提供診斷結果 | 移至人工驗收清單 |
| `api.chat.variables` 暫時覆蓋正式 `_drive_sync` | 可能干擾 chat ID、同步路徑或自動同步事件 | 預設自檢禁用；改成唯讀能力檢查 |
| `api.character.roundtrip` 建立暫存角色卡 | 失敗時可能殘留資料 | 移至需確認的進階診斷，強制清理 |
| `chat.replace.roundtrip` 短暫改寫目前聊天 | 中途事件、分頁競態或例外可能同步測試內容 | 移至需確認的進階診斷，只允許測試聊天執行 |
| Preset 自檢使用 `getPreset('in_use')` | 與正式 adapter 使用的 `getPresetManager()` 不一致 | 依正式 adapter 重寫 |
| Worldbook 自檢檢查未使用的 `importRawWorldbook` | 可能自檢通過但正式備份／還原不可用 | 依正式 export/apply/binding API 重寫 |
| Regex 只檢查讀取，Persona 完全未檢查 | 無法判斷完整環境備份／還原是否可用 | 補齊五類 item 能力矩陣 |
| `drive.real.smoke` 寫入後沒有 `finally` 清理 | 中途失敗可能留下自檢檔案 | 使用唯一 run ID 並強制清理 |
| runner 沒有 timeout、執行鎖與逐項進度 | 單一 API 卡住會讓整輪停住；可重複啟動多輪 | 補 runner 韌性與狀態回呼 |
| `skip` 同時代表未連線、未選聊天、缺 API、故意不執行 | 使用者無法判斷是否需要處理 | 拆分 blocked／not_applicable 語義 |
| 結果只輸出平面文字 | 缺少摘要、分類與修復方向 | 改成結構化診斷結果 UI |

## 安全原則

1. **快速檢查預設唯讀**；唯一例外是使用者知情的 Drive 暫存檔 CRUD，且必須寫入 `_self_check/<run_id>` 並在 `finally` 清理。
2. 快速檢查不得改寫 `_drive_sync`、聊天訊息、角色卡、世界書、Persona、Preset 或 Regex。
3. 任何會建立、覆寫或刪除使用者內容的案例都屬「進階診斷」，執行前顯示影響範圍並要求確認。
4. 缺少產品必需 API 應判定為 `fail`；只有缺少使用者前置狀態時才是 `blocked`；真正不適用才是 `not_applicable`。
5. 每個非 pass 結果必須附可行動建議，例如「前往連線」、「選擇一個聊天」、「更新酒館助手」。

## 任務

### 7-A 自檢資料模型與 runner 韌性（P0）

- [x] 擴充 `SelfCheckCase`：加入 `category`、`safety: 'read_only'|'temporary_write'|'destructive'`、`mode: 'quick'|'advanced'`、`timeoutMs`（前置條件由各 case 回傳 blocked 與 action）。
- [x] 擴充結果狀態為 `pass | fail | blocked | not_applicable`；移除語義含混的單一 `skip`。
- [x] 結果加入 `remediation`、可選 `action`、`startedAt`，並保留 `details` 供複製診斷報告。
- [x] `runSelfChecks` 支援 quick／advanced 篩選、逐項 `onProgress` 回呼與每項 timeout；單項 timeout 不阻斷後續案例。
- [x] 加入執行鎖，同一時間只允許一輪；重複點擊回傳目前執行狀態，不得啟動第二輪。
- [ ] runner 對每個 case 隔離例外，並確保 cleanup 錯誤能單獨回報，不掩蓋原始錯誤。

### 7-B 清理預設自檢項目（P0）

- [x] 從產品自檢移除 `drive.mock.memory`，由既有 Vitest 覆蓋。
- [x] 從產品自檢移除 `settings.persistence` 的寫入行為；保留成 CI 測試，快速檢查改為唯讀設定驗證。
- [x] 從產品自檢移除 `chat.pack.roundtrip`，由 package 單元測試覆蓋；快速檢查改驗證目前聊天可讀與可匯出。
- [x] 從產品自檢移除 `ui.panel.mounted`；DOM 結構由 `panelView` 測試覆蓋。
- [x] 移除永遠 skip 的 `api.chat.importRawChat`，將其保留於人工相容性驗收文件。
- [x] 移除會改寫正式 chat variables 的案例；Character／Chat roundtrip 移至 advanced，不得出現在快速檢查。

### 7-C 快速檢查：設定與連線（P1）

- [x] `settings.valid`：唯讀檢查 Google Client ID、裝置名稱、自動同步 N、保留策略是否合法；不得修改 localStorage。
- [x] `drive.connection`：顯示連線狀態與帳號；未連線回 `blocked` 並提供「前往連線」。
- [x] 重寫 `drive.real.smoke`：以唯一 run ID 執行 ensureFolder → upload → list → download → delete，寫入前清楚標示會建立暫存檔。
- [x] Drive smoke 使用 `try/finally` 清理檔案；若清理失敗，結果需標示暫存路徑與人工清理方式。
- [ ] 驗證 Drive list/query 能讀取 `SillyTavernSync` 下由本插件建立的資料，不把「沒有任何備份」判成錯誤。

### 7-D 快速檢查：目前聊天與同步（P1）

- [x] `chat.context.ready`：檢查目前是否已選角色與聊天檔名；缺前置狀態回 `blocked`。
- [x] `chat.readable`：檢查訊息、swipes 與 chat variables 可讀且型別正確，不寫入任何變數。
- [x] `chat.raw_export`：實際呼叫唯讀 `/api/chats/export`，確認回傳 JSONL 且可解析訊息數；這是聊天上傳與覆蓋前還原點的必要條件。
- [x] `autosync.events`：檢查 `eventOn` 與實際使用的事件名稱／fallback，不實際觸發生成或上傳。
- [x] `autosync.queue`：檢查待傳佇列可解析、項目 schema 合法；若有待傳項目顯示數量與最舊項目時間。
- [x] `autosync.readiness` 檢查自動同步已啟用但 Drive 未連線的矛盾狀態，回傳 blocked/remediation；目前聊天能力由 chat 分組獨立呈現。

### 7-E 快速檢查：完整環境備份／還原能力（P1）

- [x] 使用正式 `TavernChatAdapter` 的 export 方法逐項做唯讀檢查，不另寫一套與實作分離的 API 判定。
- [x] Character：檢查目前角色存在、`getCharacter('current')` 成功、snapshot 基本 schema 正確；不建立角色副本。
- [x] Worldbook：檢查 `getWorldbook`、目前實際綁定讀取能力與 bundle schema；移除無關的 `importRawWorldbook` 判定。
- [x] Persona：新增 `getPersona('current')` 與 snapshot schema 檢查。
- [x] Preset：改用正式 `getPresetManager('textgenerationwebui')`，檢查 selected name 與 settings；不得再以全域 `getPreset` 代表正式功能。
- [x] Regex：檢查 `getTavernRegexes({ type: 'global' })` 回傳陣列。
- [x] 建立五類 `environment.restore.*` 能力檢查，只判定 apply API 是否存在，不實際套用。
- [x] 五類 item 個別呈現 pass／fail／blocked，單一 item 失敗不得掩蓋其他結果。

### 7-F 快速檢查：從雲端建立聊天（P1）

- [x] 保留並擴充 `api.chat.pull.support`，對齊 `createTavernPullAdapter` 的實際依賴。
- [x] 檢查 `context.characters`、`selectCharacterById`、`openCharacterChat`。
- [x] 檢查 `insertOrAssignVariables`、`createOrReplaceCharacter`，並由正式 adapter 驗證目前角色 avatar 解析能力。
- [x] 唯讀呼叫 `/api/characters/chats`，確認目前角色聊天清單可讀；不呼叫 `/api/chats/save` 建立檔案。
- [x] 將「目前沒有角色／聊天」與「宿主 API 不相容」分別回報 blocked／fail。

### 7-G 進階診斷與資料保護（P2）

- [x] 進階診斷入口與快速檢查分離，執行前顯示「可能建立或修改測試資料」並要求確認。
- [x] Character roundtrip 僅建立明確標記的暫存角色卡，使用 `try/finally` 刪除；若無 delete API 則不得自動執行。
- [x] Chat replace roundtrip 僅允許使用者確認過的測試聊天；開始前保留完整 package，結束後比對並於 `finally` 還原。
- [ ] 進階診斷期間暫停自動同步，避免測試中的暫態資料被上傳；結束後恢復原設定。
- [ ] 真實五類環境備份一律寫入 `_self_check/<run_id>`，不得污染正式 role/chat 路徑。
- [ ] 完整備份→還原 roundtrip 僅列入專用驗收模式，不作為一般使用者快速檢查。

### 7-H 結果 UI 與操作體驗（P2）

- [x] 將「自檢」改名為「系統檢查」，提供「快速檢查」與「進階診斷」兩個入口。
- [x] 執行期間停用重複啟動，顯示目前案例、完成數／總數與逐項 spinner。
- [x] 結果依「設定與連線／目前聊天／環境備份／環境還原／雲端建立聊天／自動同步」分組。
- [x] 頂部顯示摘要：全部正常／需要處理 N 項／缺少前置條件 N 項；不得把 blocked 顯示為成功。
- [x] fail 與 blocked 顯示具體修復建議；連線／設定問題提供可操作按鈕。
- [x] 預設隱藏毫秒與技術 details；提供「複製診斷報告」與遮蔽 access token／完整 Client ID。
- [x] 關閉面板後保留本輪結果；重新開啟可查看，直到下一輪取代。

### 7-I 文件與舊規格回寫（P2）

- [x] 更新開發手冊的自檢定義：區分快速檢查、進階診斷、CI 與人工驗收。
- [ ] 回寫 Phase 0–6 中已過時的「一鍵自檢」項目歸屬，避免把 CI／破壞性案例誤列為預設自檢。
- [x] 更新 `docs/api-notes.md`，記錄正式 adapter 依賴的 API、fallback 與已知宿主版本差異。
- [x] 補 [系統檢查使用說明](../docs/system-check.md)：快速檢查是否寫 Drive、暫存路徑、清理策略與報告中各狀態的意思。

## 建議實作順序

**7-A → 7-B → 7-C／7-D → 7-E／7-F → 7-G → 7-H → 7-I**。

先建立安全分層與 runner 韌性，再搬移舊案例；否則 UI 改完後仍會執行高風險案例。快速檢查各分類可分批交付，進階診斷最後加入。

## 驗收標準

### CI 自動測試

1. runner：單項 throw／timeout 後仍執行後續案例；逐項 progress 順序與最終摘要正確。
2. 執行鎖：快速連點只啟動一輪；完成後可再次執行。
3. quick catalog 不得包含 `destructive` case，且不得註冊 MemoryDrive、UI DOM、pack/unpack、importRawChat 案例。
4. blocked／fail／not_applicable 分類與摘要計數正確。
5. Drive smoke 無論 upload、list、download 或 assertion 哪一步失敗都會進入 cleanup；cleanup 失敗保留可追查路徑。
6. 五類環境 export／restore capability 以 adapter mock 驗證每項獨立結果，Preset 使用 manager API，Persona 不得缺席。
7. chat raw export、queue schema、cloud-create capability 的成功／缺前置／缺 API fixture 均有測試。
8. 診斷報告遮蔽 access token、完整 Client ID 與其他敏感資料。

### 真實酒館快速檢查

9. 已連線且有目前聊天時，快速檢查全程不改動聊天內容、`_drive_sync`、角色卡與五類環境資料。
10. 未連 Drive、未選角色、空聊天、缺單一宿主 API 時，分別顯示正確 blocked／fail 與修復方向。
11. Drive smoke 完成後 `_self_check/<run_id>` 不殘留測試檔；故意中斷網路後仍執行 cleanup 並提供殘留路徑。
12. 500+ 樓聊天執行快速檢查不做聊天覆寫，且每項 timeout 後仍能完成整體報告。

### 進階診斷與手動驗收

13. 在專用測試角色／聊天執行 Character 與 Chat roundtrip，完成後資料 deep-equal 且沒有暫存角色或聊天殘留。
14. 進階診斷中途關閉面板或單項失敗，仍恢復自動同步設定並執行 cleanup。
15. 暗色／亮色／手機寬度下，分組結果、狀態與 remediation 操作清楚可讀（屬視覺與語意判讀，保留人工驗收）。

## 完成定義

- 快速檢查不含任何會改寫正式本機資料的案例。
- 快速檢查的每個非 pass 結果都有清楚原因與下一步。
- CI、快速檢查、進階診斷與人工驗收的案例歸屬不重複、不互相取代。
- `npm run verify` 全綠，並完成一次真實 Drive cleanup 中斷測試。
