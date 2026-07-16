# Phase 2：聊天同步核心

> 規格對應：[開發手冊-v2.md](../開發手冊-v2.md) 第四章、第七章補充、第八章
> 目標：M1 —— 一個聊天窗能在 A/B/C 之間流動（手動上傳 + 自動同步 + 簡單拉取）

## 任務

### chat_id 機制（4.1、4.2）
- [x] `ensureSyncMeta()`：讀 chat 變數 `_drive_sync`；`chat_id` 以目前聊天檔名時間戳為準，例：`路特 - 2026-06-28@15h24m22s470ms.json` → `2026-06-28@15h24m22s470ms`；`role_key` 仍以當前角色名安全化後固定，並寫回 chat 變數
- [x] `last_synced_version` 讀寫
- [x] 面板顯示 chat_id（無則「尚未同步」）

### 聊天打包/解包
- [x] `packChat()`：完整訊息（含 swipes）+ chat 變數 + 聊天綁定世界書名 → 單一 JSON
- [x] `unpackChat()`：反向還原用的解析與格式驗證（版本欄位 `format_version: 1` 預留升級）
- [x] 打包內容附 metadata：chat_id、role_key、device、訊息數、打包時間

### 手動上傳
- [x] `[手動上傳目前聊天]`：ensureSyncMeta → packChat → ensureFolder → upload → 更新 last_synced_version → toast 結果

### 自動同步（第八章）
- [x] 掛 AI 回覆完成事件計數，達 N（設定值，預設 1）觸發上傳，10 秒 debounce
- [x] 上傳失敗進待傳佇列（腳本變數持久化），下次觸發/手動上傳/重新連線時補傳
- [x] 自動同步開關 + N 值設定 UI
- [x] chat item 的 keep_latest_n 清理（設定啟用時，上傳後刪多餘舊版）

### 狀態判斷（第七章補充）
- [x] 三態判斷：比對 last_synced_version vs 雲端最新 vs 本地變更 → 「已是最新／雲端有新版／本地有未上傳變更」
- [x] 面板顯示狀態

### 簡易拉取（M1 用最小版，完整版在 Phase 4）
- [x] 面板提供「下載最新聊天版本並覆蓋」：本地已有同 chat_id → 就地覆寫全部樓層；覆蓋前先把本地現狀上傳 `_pre_restore/`（借用 Phase 1 的 upload，先做最簡單版本）

## 驗收標準（= M1 驗收）

### 自動（CI，對 mock Drive）
1. `ensureSyncMeta`：無 meta 時由聊天檔名導出 `chat_id` 並建立 role_key；已有 meta 但 `chat_id` 與當前聊天檔名不一致時，自動重綁成檔名時間戳（角色改名後 role_key 仍固定）
2. `packChat`/`unpackChat` 來回 deep-equal；`format_version` 不符與損壞 JSON 被拒絕
3. 三態判斷真值表：last_synced × 雲端最新 × 本地變更 全組合 → 「已是最新／雲端有新版／本地有未上傳變更」
4. 自動同步觸發：fake timer 下事件連發 → N 未達不傳、達 N 觸發一次、10 秒 debounce 合併
5. 佇列：上傳失敗入列持久化 → 重連後補傳、成功出列；補傳再失敗不丟資料
6. keep_latest_n=3：上傳第 4 版後 mock 目錄僅剩最新 3 檔，刪的是最舊的

### 自動（一鍵自檢，真實酒館）
7. 當前聊天 pack → unpack → 訊息陣列（含 swipes）與 chat 變數 deep-equal
8. 就地覆寫案例：pack 現狀 → 改動一樓 → 用 pack 還原 → 斷言與原始一致（長聊天效能同場計時，>500 樓超過門檻即標紅——對應風險備註的換路決策點）

### 手動（無法自動的理由附註）
9. A 聊 3 句自動上傳 → B 拉取續聊 → C 拉到 B 的版本，三環境輪轉一圈（*跨裝置實機 + 真實 Drive + 真實使用流程*）
10. 實際斷網（關 Wi-Fi）聊天 → 恢復後補傳（*真實網路狀態切換*）
11. 「本地有未上傳變更」警告的呈現與文案（*UI 視覺*）

## 風險備註
- 「就地覆寫全部樓層」對超長聊天（500+ 樓）的效能要實測，太慢則改整檔級操作（回頭查酒館原生 chat save 端點）——這是本 phase 最可能需要換路的點
- 多分頁防護（十五-2）此階段先不做，Phase 5 收
