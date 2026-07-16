# Phase 6：面板樣式與操作進度優化

> 規格對應：[開發手冊-v2.md](../開發手冊-v2.md) 第十四章（本 phase 需先回寫擴充，見 6-E）
> 前置：Phase 3 備份 / Phase 4 還原流程存在（進度清單掛在 `backupItems` / `restoreLatest` 上）
> 目標：面板外觀對齊酒館原生擴充；備份/還原逐檔進度清單（列出所有檔案、完成打勾）；狀態列補齊 14.1 欄位並上色；操作依手順分區與防呆

## 現況問題（優化動機）

| 現況 | 位置 | 問題 |
|---|---|---|
| 面板用自訂 CSS，不吃酒館主題變數 | `src/ui.ts` `injectStyle` | 換主題後顏色突兀，藍色主按鈕寫死 |
| 所有回饋擠在單一 `<pre>` 報告區 | `src/ui.ts` `setReport` | 備份 5 個檔案只顯示「正在備份…」，中間無進度感 |
| `backupItems` 無進度回呼，首項失敗即 throw | `src/environment/EnvironmentBackupService.ts` | 部分成功的結果遺失，不知道哪些傳完了 |
| `restoreLatest` 步驟更多（覆蓋前備份→下載→套用）同樣無進度 | `src/environment/EnvironmentRestoreService.ts` | 還原是最需要進度與確認的操作 |
| 手冊 14.1 的「最後同步」「自動同步每 N 則」未顯示，待傳佇列數未露出 | `src/ui.ts` `renderPanel` | 狀態區資訊不完整 |
| 設定、狀態、按鈕全部平鋪 | `src/ui.ts` `renderPanel` | 首次設定與日常操作混在一起，無手順感 |

## 任務

### 6-A 面板樣式對齊酒館原生

- [x] 外殼改酒館標準 `inline-drawer` 可收合結構（`.inline-drawer-toggle` 收合由酒館全域委派處理，不自寫邏輯；浮動模式才綁 fallback toggle）
- [x] 控件換酒館標準 class：按鈕 `menu_button`（帶圖示 `menu_button_icon` + `fa-solid fa-*`）、文字輸入 `text_pole`、勾選 `checkbox_label`、排版 `flex-container`；移除寫死的藍色 `.tr-primary`
- [x] 顏色/字體改吃主題變數（`--SmartThemeBodyColor`、`--SmartThemeBorderColor` 等，一律附 fallback），自訂 CSS 只保留佈局
- [x] 浮動模式（掛不到 `extensions_settings` 時）保留縮減後的保底樣式（scoped 於 `.tr-floating`）

### 6-B 備份/還原進度清單

service 層：

- [x] `src/environment/types.ts` 新增進度事件型別：`{ kind, step: 'export'|'upload'|'backup_current'|'download'|'apply', state: 'start'|'done'|'error', filename?, error? }`
- [x] `backupItems` 加 `onProgress` 回呼；**單項失敗記錄後繼續下一項**，回傳逐項 `status: 'done'|'error'` 結果（取代現在 throw 全斷）——並補上同批共用同一時間戳（手冊第九章）
- [x] `restoreLatest` 同樣接上 `onProgress`；**「覆蓋前備份」失敗時該項中止、不套用**（status `aborted`），其他項繼續；skipped 項不備份不發事件，僅在回傳 items 標示

UI 層：

- [x] 進度清單元件取代單行文字：每檔一列，狀態為「等待（灰）→ 進行中（`fa-spinner fa-spin`）→ ✓ 完成（附檔名）→ ✗ 失敗（附原因）→ ⚠ 中止 → · 略過」，頂部 `n/m` 計數 + 進度條（事件即時更新、回傳結果兜底補畫 skipped）

  ```
  備份完整環境                              3/5
  ──────────────────────────────
  ✓ 角色卡      2026-07-07T06-12-30Z__A電腦.json
  ✓ 世界書      2026-07-07T06-12-31Z__A電腦.json
  ◌ Persona    上傳中…
  · Preset     等待中
  ✗ Regex      失敗：token 過期  [重試]
  ```

- [x] 失敗項提供單項「重試」按鈕（只重跑該 kind；還原重試會建新還原點，已註明可接受）
- [x] 手動上傳聊天、下載覆蓋走同一元件（單列），行為一致

### 6-C 手順分區與操作防呆

- [x] 面板依使用順序分區：**狀態列（常駐）→ 日常操作（手動上傳/下載覆蓋）→ 環境備份/還原（item 勾選 + 進度清單就地顯示）→ 連線與設定**（Client ID、裝置名、自動同步 N；未填 Client ID 時自動展開並顯示引導文字）
- [x] 未連線 Drive 時 disable 上傳/備份/還原/下載按鈕並提示「請先連線 Google Drive」
- [x] 「下載並覆蓋」「還原環境」二次確認，列出將被覆蓋項目與雲端缺檔的 skipped 項（優先用酒館 `callGenericPopup`，拿不到退回 `confirm()`；還原前用 `onPreviewRestore` 預檢，預檢失敗保守視為全部覆蓋）——對應手冊 11.3

### 6-D 狀態列顯示優化

- [x] 狀態改色點 pill：已是最新（綠）／雲端有新版（黃）／本地有未上傳變更（橘）／未連線（灰、未知同灰），資料來源沿用 `computeSyncStatus`
- [x] 補「最後同步時間」：由 `meta.last_synced_version` 檔名經 `formatLastSyncedLabel`（純函式，`src/drive/version.ts`）解析 UTC 轉本地時區顯示，無 meta 顯「—」
- [x] 補「待傳佇列」：`loadUploadQueue().length` > 0 時橘色顯示「待傳 N 筆」，=0 顯正常色「無」（欄位常駐較不跳動），flush 後經 refreshPanelContext 更新
- [x] 補「自動同步：每 N 則 / 已停用」，儲存設定後即時刷新

### 6-E 手冊回寫（依工作約定，動工前完成）

- [x] 新版面板分區、進度清單規格、狀態列欄位回寫 [開發手冊-v2.md](../開發手冊-v2.md) 第十四章（改組為 14.1–14.6，第九、十二章補失敗語義互引）

## 建議實作順序

**6-E → 6-A → 6-B → 6-C / 6-D**。進度清單與狀態列都長在 6-A 的新版面骨架上，反序會重工；6-C 與 6-D 互相獨立可並行。三塊皆可分批交付，每階段完成即可在真實酒館看效果。

## 驗收標準

### 自動（CI）

1. `backupItems` 進度事件順序：每 kind 依序 export start/done → upload start/done；注入單項失敗 → 該項發 error 事件、其餘照常完成、彙總結果逐項標示正確（mock Drive，擴充 `tests/environmentBackupService.test.ts`）
2. `restoreLatest`：backup_current 失敗 → 該項不發 download/apply、結果標示中止；其他項照常（擴充 `tests/environmentRestoreService.test.ts`）
3. 「最後同步時間」檔名解析純函式：各種檔名 fixture 的 UTC → 本地轉換與無效檔名容錯
4. 待傳佇列計數顯示邏輯（佇列空/非空/flush 後）

### 自動（一鍵自檢，真實酒館）

5. 面板掛載於 `extensions_settings2` 且 `inline-drawer` 結構存在、收合開闔可用（DOM 斷言）
6. 真實 Drive 備份一輪，收到的進度事件數 = 勾選 item 數 × 2（export + upload），且逐項 status 為 done

### 手動（無法自動的理由附註）

7. 各主題（暗/亮/自訂）下面板跟色、與原生擴充視覺一致性（*UI 視覺*）
8. 進度清單動態效果：spinner、逐項打勾、n/m 進度感（*動態視覺*）
9. 二次確認彈窗文案與「將被覆蓋清單」正確性（*語意判讀*）

## 進度註記（2026-07-08）

- 全部開發任務（6-A～6-E）已完成，`corepack pnpm verify` 全綠：lint / typecheck / vitest 17 檔 59 測試 / production build（139 KiB）
- 驗收標準 1–4（CI）已由新增測試覆蓋（`tests/environmentBackupService.test.ts`、`tests/environmentRestoreService.test.ts`、`tests/version.test.ts`、`tests/panelView.test.ts`）；驗收 5（自檢）已加 `ui.panel.mounted` 探針
- **驗收 6 未實作**：真實 Drive 備份自檢需實際 export 五類 item 寫入使用者 Drive，具污染性，與既有「自檢不自動建檔」原則衝突——留待人工驗收，建議後續加獨立 `_self_check` 路徑的專用探測
- 驗收 7–9（手動：主題跟色、進度動態、確認框文案）待真實酒館環境人工驗收
- 規格縫隙待處理：手冊 14.2 的 `[檢查完整環境更新]`、`[還原覆蓋前備份]` 按鈕與 14.6 版本選擇區屬 Phase 4 範圍，本 phase 未實作；還原重試會堆積 `_pre_restore` 還原點，手冊十二章「保留最近 3 筆自動清舊」尚未實作（Phase 4）

## 風險備註

- 酒館 class 名與 `--SmartTheme*` 變數屬酒館內部實作，升版可能改名——樣式全部附 fallback，斷版時退回保底樣式，功能不受影響
- `callGenericPopup` 在酒館助手 iframe 內的取得方式依 JS-Slash-Runner 版本而異，拿不到一律退 `confirm()`
- `backupItems` 回傳型別改為含逐項 status，屬 breaking change，需同步修 `src/index.ts` 接線與既有測試
