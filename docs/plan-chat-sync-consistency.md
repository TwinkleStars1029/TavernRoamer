# 聊天同步一致性與補傳流程修改規劃

日期：2026-09-08  
狀態：第一批實作完成，待真實酒館驗收  
範圍：架構檢視建議第 1 項「操作綁定聊天對象」與第 2 項「上傳成功與清理失敗分離」。

目前已完成：固定聊天 ref、同聊天操作排程、逐聊天自動同步計數、延後同步 receipt、上傳／metadata／清理分階段結果、清理重試佇列、預先配置 Drive 檔案 ID、409 核對、頁面卸載清理、版本化內容 hash、拉取目標隔離、context revision，以及競態與故障注入測試。尚待真實酒館驗證指定非當前聊天匯出、未落盤編輯、切換聊天時的保存／開啟行為及超過 5 MiB 的 resumable upload；跨分頁鎖、帳號綁定與佇列容量政策仍保留為後續強化項目。

2026-09-23 補充：最新規格以 [開發手冊-v2.md](../開發手冊-v2.md) 第十八章「操作目標與內容一致性」、第十九章「還原資料驗證與格式相容」為準。本文件的「第 2 項」是先前的上傳／清理拆分，不是本輪優先項目 2；本輪只納入目標、內容與還原資料驗證所需修改，未把本文件的全部佇列強化一併排入。手冊新增先驗證再備份、格式遷移及完整驗收契約；以下各節保留為第一批工作的背景與設計參考。

## 1. 目標與範圍

完成後應保證：

1. 在聊天 A 啟動的工作，只能讀寫 A；使用者切到 B，不得改寫 B 的聊天或 metadata。
2. 手動上傳、自動上傳、失敗補傳及下載覆蓋，共用同一聊天的操作排程。
3. 已確認上傳成功的工作，不因 metadata 寫入、清理或面板更新失敗而重新上傳。
4. 相同工作的網路重試及重啟後補傳，沿用相同的遠端檔案身分。
5. 佇列未成功持久化時，不顯示「已加入待傳佇列」。

本次沿用純前端腳本、現有 Drive 目錄、JSONL 主格式與既有聊天 ID 規則。UI 只調整操作結果與必要提示。全面 UI 拆分、環境備份格式重構、一般性的同步衝突判定屬其他工作。

協調器第一版保證單一腳本實例內的順序；多分頁共享儲存的原子鎖、多裝置清理協調不在本次保證內。不可把實例內 Promise 鎖宣稱為跨分頁鎖。

## 2. 現況與對應問題

| 位置 | 現況 | 要修正的行為 |
|---|---|---|
| `src/chat/ChatSyncService.ts`：`uploadCurrentChat` | 先取得 meta，數個 await 後寫回 current chat | 固定操作對象，完成時不得寫入其他聊天 |
| `src/tavern.ts`：`replaceRawChat` | 呼叫當下重新取得目前角色與聊天 | 由呼叫端傳入明確的本地檔案定位 |
| `src/chat/AutoSyncController.ts` | 全域訊息計數與無參數延遲上傳 | 各聊天分開計數，延遲工作保留來源身分 |
| `src/index.ts` | 上傳與補傳分別觸發；未回收事件訂閱及 autoSync timer | 統一入口並建立 dispose；過時查詢不得更新目前面板 |
| `src/chat/ChatSyncService.ts`：`uploadCurrentChat` | 上傳、刪除舊版、更新 meta 共用 catch | 上傳成功先記錄，再分別處理其他步驟 |
| `src/chat/ChatSyncService.ts`：`flushQueue` | 補傳成功只移除項目 | 沿用一般上傳的確認、metadata 處理及維護流程 |
| `src/chat/queue.ts` | 無工作階段、上限、遠端 ID 或完成紀錄 | 加入可恢復工作狀態及明確儲存錯誤 |
| `src/ui.ts`：`runSingle` | callback 回傳字串即顯示完成 | 區分已上傳、待補傳、清理待重試、操作中止 |

## 3. 第 1 項：固定聊天身分與操作順序

### 3.1 建立 ChatRef 與不可變快照

新增 `src/chat/context.ts`，區分三種身分：

- 本地對象：角色頭像檔識別 `avatarUrl`、原生聊天檔案主幹 `fileName`，必要時加執行環境識別。
- 雲端對象：`roleKey`、`chatId`。不可只用角色顯示名稱或角色陣列索引識別本地對象。
- 工作身分：唯一 `operationId`，重試時不重新生成。

建議介面輪廓（欄位名稱可於實作時調整）：

```ts
type ChatRef = Readonly<{
  avatarUrl: string;
  fileName: string;
  roleKey: string;
  chatId: string;
}>;

type ChatSnapshot = Readonly<{
  ref: ChatRef;
  content: string;
  messageCount: number;
  capturedAt: string;
  contentHash: string;
}>;
```

`captureCurrentChatRef()` 在使用者啟動操作或收到來源事件時擷取。後續 API 均接收 ref，不在執行中用 current 替換目標。為避免碰撞，鎖鍵採結構化序列化，不用未跳脫的字串拼接。

`contentHash` 僅用於比對本次快照與安全回寫 metadata；正規化只排除 `_drive_sync` 自己的同步簿記，不忽略正文、swipes、使用者 chat variables 或其他有效 metadata。一般狀態列的內容差異判定仍另案處理。

### 3.2 酒館 adapter 明確定位

調整 `src/tavern.ts` 與聊天 adapter 型別，提供：

- `exportRawChat(ref)`：request body 使用 ref 的角色與檔名。
- `replaceRawChat(ref, content)`：保存到指定 ref；只有目前仍是同一對象，才刷新目前聊天畫面。
- `isCurrentChat(ref)`：核對角色檔與聊天檔，不能只比較 chat_id。
- `commitSyncReceiptIfCurrent(ref, receipt)`：核對身分及快照匹配後，合併同步欄位，避免整包覆蓋較新的 meta。

非當前聊天的成功結果先保存為 receipt；切回該聊天後再比對並處理。不得為了更新一個同步欄位，將舊的整份 JSONL 寫回已被使用者修改的聊天。

實作前先驗證兩個 adapter 邊界：

1. 用既有 export/save 端點指定非當前聊天，是否讀寫正確且不誤刷新其他聊天。
2. 舊版 `.json` package 的套用目前有多個 current-based await。必須轉為已驗證的指定檔案寫入，或使用確實支援指定目標的 API；不可只在函式開頭加一次身分檢查後，仍逐步操作 current。若沒有可安全套用的路徑，應在第一個改寫前回報不支援；不得先刪訊息再發現無法繼續。轉換需保留正文、swipes、變數與世界書綁定，並以既有相容測試驗證。

### 3.3 同一聊天的工作依序執行

新增 `src/chat/ChatOperationCoordinator.ts`：

- 同一個本地聊天的手動上傳、自動上傳、補傳與下載覆蓋，經相同的操作入口排程。
- 同一雲端聊天的保留策略清理也共用遠端路徑鎖，避免本實例中清理與寫入互相交錯。
- 任一工作失敗均以 finally 釋放鎖，不阻塞後續工作。
- `flushQueue()` 共用一次正在執行的 Promise；連線、手動操作與自動同步同時要求補傳，不得產生多個 worker。
- 佇列儲存的讀取／修改／寫入另經單一儲存入口序列化，避免不同聊天同時更新而遺失項目。
- 避免巢狀取得同一鎖：公開入口取得鎖，內部執行函式不再取得同一把鎖。

上傳按鈕點下時即擷取 ref；等到輪到該工作時，匯出這個 ref 的內容，而不是屆時畫面上的聊天。下載開始後暫停該 ref 的新自動上傳；尚未匯出的觸發只記 dirty 意圖，既有失敗快照仍保留原時間、原內容，不重新命名成新版。

### 3.4 切換聊天時的具體行為

| 情境 | 預期行為 |
|---|---|
| A 上傳中切到 B | 繼續上傳 A；結果存入 A 的 receipt；B 的內容與 meta 不變 |
| A 自動同步 debounce 中切到 B | 保留 A 的 ref，到期匯出 A；若 A 已刪除／改名則回報來源不可用，不改為上傳 B |
| A 下載中、送出保存前切到 B | 中止套用並提示「已切換聊天，更新未套用」；已完成的還原點保留 |
| A 的保存請求已送出才切到 B | 請求仍只能保存 A；不刷新 B，不聲稱已取消已送出的寫入 |
| A 等待套用期間又收到新訊息或編輯 | 套用前重新比對本地快照；有差異則中止本次套用，避免覆蓋下載等待期間的新內容 |
| B 已開啟後 A 的狀態查詢才回來 | 面板依 ref 與 request generation 丟棄過時結果 |

下載保持「保存成功的覆蓋前備份 → 套用」必要順序。下載與解析可先完成，縮短建立還原點到套用之間的時間。瀏覽器端檢查不是伺服器原子 compare-and-swap，其他分頁或裝置同時寫本地檔案仍屬上述範圍外限制。

`ChatPullService` 會主動選角及開啟聊天，需最小幅度接入相同 context guard：保存目標明確化、最後 metadata 回寫核對目標，並讓切換流程使過時下載失效。本次不重構其角色匹配及備份邏輯。

### 3.5 自動同步與生命週期

- `AutoSyncController` 改為依 ChatRef 計數與 debounce；callback 接收來源 ref。
- timer 執行時再次檢查自動同步設定。停用時取消尚未開始的自動工作，不刪除已持久化的失敗快照。
- `index.ts` 收集事件取消訂閱函式、launcher retry timer 與 controller dispose。
- pagehide／腳本卸載時停止新工作與面板更新；已送出的遠端請求可能完成，交由持久化工作在下次啟動時核對，不能假設 AbortSignal 撤回了寫入。
- 可注入 timer、clock 及 ref provider，便於用 fake timer 與延遲 Promise 測試。

## 4. 第 2 項：共用上傳工作與獨立維護

### 4.1 使用持久化工作，不只存失敗陣列

保留 `queue.ts` 作為相容入口，逐步移出 `ChatSyncService` 的重複上傳分支。新增 `UploadJobRunner.ts` 負責共同執行流程，`UploadJournal.ts` 負責工作與 receipt 儲存。

工作至少包含：

- `schemaVersion`、`operationId`、ref（舊資料可暫缺本地定位）、雲端 path。
- 不可變的 payload、MIME、snapshot hash、messageCount、capturedAt、filename。
- 首次傳送前取得並保存的 `remoteFileId`，以及建立時使用的 parent folder ID。
- 工作階段、attempts、nextAttemptAt、lastError，以及已確認的遠端 receipt。
- 工作建立時的帳號關聯；若帳號無法可靠辨識或與工作不符，保留待處理狀態，不自動把既有工作送入另一帳號。帳號識別方式需依實際授權介面驗證，不把可為 null 的 email 當作可靠 ID。

狀態流程：

```text
captured → pending_upload → remote_verified → finalized
                  ↘ retry_wait ↗

remote_verified ─→ metadata 處理：applied / deferred / superseded
                └→ 清理工作：pending / done / retry_wait
```

`remote_verified` 是上傳成功的分界。後續 metadata／清理失敗不會讓工作返回 pending_upload。payload 可在遠端確認且 receipt 成功保存後釋放；延後的 metadata 只需保留 ref、hash、版本與計數等小型紀錄。

### 4.2 共用流程

1. 擷取 ref，經協調器匯出指定聊天，固定內容與版本檔名。
2. 先持久化工作。儲存失敗即回報，不顯示已排入佇列。
3. 解析遠端路徑、配置遠端檔案 ID，將兩者持久化後才送出檔案內容。
4. 呼叫可重試的上傳；不確定結果時，以同一 ID 核對，禁止換新 ID 盲目重傳。
5. 確認遠端結果，保存 receipt，將工作移出「尚未上傳」計數。
6. 對正確聊天處理 metadata；目前已切換就延後，內容已不同就保留較新的本地狀態，舊補傳不得倒退較新的同步紀錄。
7. 按雲端聊天路徑加入清理工作；清理獨立成功／失敗，回傳結構化結果。

手動、自動與 flush 都呼叫此 runner。補傳保持原 payload、檔名、operationId 及 remoteFileId，不重新擷取 current，不把舊內容改成重試當下時間。

### 4.3 防重複上傳與不確定結果

採用 Drive 預先產生檔案 ID 的機制。官方說明指出，同一 ID 的建立／上傳已成功時，重試會收到 409，避免建立重複檔案；JSON/JSONL 為此處使用的普通檔案類型。[Google Drive：Use a pre-generated ID to upload files](https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files)

修改 `DriveClient`、`GoogleDriveClient`、`MemoryDriveClient`，增加 ID 配置、指定 ID 上傳與單檔查驗能力：

- multipart 與 resumable 的建立階段均使用已保存的同一 ID。
- HTTP retry 層不得自行換 ID 或重建一筆工作。
- 409 不直接視為成功：用該 ID 查驗檔名、parent、大小及內容校驗值；必要時下載比較。對不上或不可讀即保留待核對狀態。
- resumable session 失效時，先核對檔案是否已完成，再決定以同 ID 重啟工作；不能把未完成 session 當成已完成檔案。
- 檔名不是冪等鍵。現有檔名精度只有秒，同名不同內容不得互相抵銷。receipt 以檔案 ID 與本地工作序號識別；本次不把秒級檔名視為完整版本身分。

### 4.4 metadata 完成與補傳

- 安全回寫條件：ref 匹配、目前內容仍對應該快照、沒有較新的已套用結果。
- 使用快照中保存的 messageCount，不讀補傳當下另一聊天的訊息數。
- 舊補傳晚於新上傳完成時，不覆蓋新的 last_synced 紀錄；以來源快照／本地工作順序判斷，不能只用網路完成順序。
- metadata 寫入失敗只重試 metadata，不能再次上傳。
- 切回聊天處理 deferred receipt 前，先匯出並比對內容；核對後至同步寫入間再次檢查目前身分。無法證明安全則延後，不猜測成功。
- 下載覆蓋前處理同 ref 正在執行的上傳；歷史失敗快照可以保留為歷史版本，但不能在下載後自動回寫舊 metadata。

### 4.5 獨立版本清理

新增 `src/chat/ChatRetentionService.ts`，僅處理 chat item：

- 上傳確認成功便產生小型清理任務；失敗顯示「已上傳，舊版本清理待重試」。
- 每次清理重列該雲端路徑的版本聯集，涵蓋同名資料夾，避免只清本次上傳所在的單一 folder。
- 按 keep_all／keep_latest_n 決定候選清單；保護仍在處理的上傳與尚未完成 receipt 處理所需檔案。待相關工作結束再重新計算，不為了硬湊 N 而刪除仍需核對的版本。
- 多項刪除部分成功時記錄失敗並重試清理；已不存在的清理目標可視為完成，403 等錯誤仍保留。
- 同一路徑的多次清理請求合併；清理不得重新上傳 payload，且不得刪除 `_pre_restore`。
- 多裝置同時套用保留策略的全域一致性另案處理，本次只避免本實例內競爭。

### 4.6 儲存容量與舊佇列相容

第一版沿用腳本變數／localStorage，包成可注入的儲存介面，先不引入 IndexedDB 遷移。

目前已加入 100 筆／20 MiB 的初始硬上限、序列化大小計算及寫入失敗的明確錯誤；完整 IndexedDB payload 搬移、帳號綁定與系統檢查容量呈現仍屬後續階段。

- 設定可測試的 `maxQueuedItems` 與 `maxQueuedBytes`；初始建議上限為 100 筆／20 MiB，實際後端可能更早達配額，必須處理每次寫入失敗，不能把此上限宣稱為可用容量。
- 達上限不靜默移除舊快照，也不預設合併不同時間的失敗快照；回報「本次快照未保存至待傳佇列」。僅相同 operationId 去重。
- 系統檢查顯示待傳數量、大小及儲存問題，不輸出完整聊天內容或 token。
- 升級時保留舊 key，先成功寫入並驗證新版工作，再標記已遷移。重跑遷移沿用舊 id，避免複製工作。
- 舊佇列由 path 取得雲端定位，不能憑 role_key 猜本地角色。缺少可靠 ref 時只允許確認後上傳，跳過自動本地 meta 回寫。
- 舊工作第一次處理前，核對同路徑、同檔名候選的實際內容；精確匹配才採認為既有上傳，不同內容不可去重。已在升級前產生的重複檔案不自動批次刪除。
- 無效項目保留原始資料並回報，不能沿用 filter 後靜默遺失資料。

## 5. UI 與入口調整

`UploadResult` 改為包含 operationId、ref、filename、upload 狀態、metadata 狀態及 cleanup 狀態的結果；`onManualUpload` 不再只回傳字串。

| 結果 | 使用者顯示 |
|---|---|
| 遠端確認成功 | 已上傳 |
| 遠端失敗且工作已持久化 | 上傳未完成，已加入待傳佇列 |
| 工作寫入儲存失敗 | 上傳工作未保存，請重試 |
| 上傳成功、清理失敗 | 已上傳，舊版本清理待重試 |
| 上傳成功、切到其他聊天 | 原聊天已上傳；不改動目前聊天狀態 |
| 下載於保存前遇到切換／新修改 | 更新未套用，並顯示具體原因 |

`index.ts` 不再先取得 queued 結果後立刻 flush、卻仍顯示過時的失敗通知。由 runner 提供該 operation 的結果，背景補傳完成以 operationId 更新對應結果；目前面板的狀態只接受目前 ref 的更新。

## 6. 實作順序與交付物

| 階段 | 主要檔案 | 可獨立驗收的交付物 |
|---|---|---|
| A：重現與明確定位 | `context.ts`、`tavern.ts`、`meta.ts`、adapter tests | 延遲網路後切換聊天也不誤寫；確認舊 JSON 套用的安全路徑 |
| B：操作協調與生命週期 | `ChatOperationCoordinator.ts`、`AutoSyncController.ts`、`index.ts`、`ChatPullService.ts` | 同聊天互斥、debounce 綁定來源、過時 UI 結果不套用、卸載清理 |
| C：上傳工作與防重複 | `UploadJournal.ts`、`UploadJobRunner.ts`、`queue.ts`、Drive clients、`ChatSyncService.ts` | 共用上傳／補傳流程、固定遠端 ID、狀態恢復、舊資料遷移 |
| D：清理與結果呈現 | `ChatRetentionService.ts`、`ui.ts`、`index.ts`、`selfCheck.ts` | 清理失敗不重傳，UI 正確區分待傳與已上傳 |
| E：整合驗收與文件 | tests、`docs/api-notes.md`、開發手冊及任務文件 | 回歸全過、測試環境操作記錄、相容性與限制同步更新 |

各階段新增檔案為建議切分，可依實作簡化；避免同時保留兩套正式上傳路徑。建議按 A → B → C → D → E 提交，階段 A 的回歸案例貫穿後續修改。

## 7. 必要測試與完成標準

使用可控制 resolve/reject 的 Promise、fake timer、可注入故障的 MemoryDrive；不要用真實 sleep 測競態。

| 類別 | 必須覆蓋的情境 |
|---|---|
| 對象隔離 | A 匯出／上傳／下載各個 await 中切 B；B 的 save request、訊息、meta、reload 呼叫完全不受影響 |
| 下載一致性 | 等待套用期間 A 有新內容則中止；備份失敗不覆蓋；已送出保存仍固定 A；舊 JSON swipes／變數／世界書相容 |
| 排程 | 自動＋手動＋flush 同時觸發同聊天只依序執行；第一筆失敗不堵死；不同聊天儲存更新不丟項目 |
| 自動同步 | A debounce 後切 B 只匯出 A；各聊天 N 分開計數；停用及 dispose 後不啟動新工作 |
| 上傳成功分界 | upload 成功後 delete 失敗、meta 寫入失敗、UI callback 失敗，都不得再次呼叫檔案建立 |
| 不確定結果 | 模擬遠端已寫入但回應遺失，重試仍只有一個 file ID；409 內容不符不視為成功；multipart／resumable 均覆蓋 |
| 重啟恢復 | 分別在保存工作、取得 ID、遠端成功、保存 receipt、清理中斷後重建 service，確認不重複上傳或遺失工作 |
| metadata | 補傳只更新來源聊天；訊息數取原快照；較舊結果不得倒退新紀錄；內容不符時不標記該快照已套用 |
| 保留策略 | keep_all 不刪；keep_latest_n、重複資料夾聯集、部分刪除失敗、404 重試、pending 保護；不觸碰還原點 |
| 相容與容量 | 舊字串／ChatPackage 工作遷移、重跑遷移、損壞項目、寫入配額失敗、相同檔名不同內容、帳號不符 |
| UI | queued 不畫成已上傳；清理待重試不畫成上傳失敗；切換後不套用舊查詢或舊進度 |

自動驗收執行 lint、typecheck、全部 Vitest 與 production build。既有 114 項測試是目前基線，重構後案例數可變，但原有功能覆蓋須保留。

真實酒館驗收使用專用測試角色、兩份可捨棄聊天與測試 Drive 目錄：慢網路時切聊天、debounce 後切聊天、斷網與重連補傳、清理失敗、重新載入後恢復，以及超過 5 MiB 的 resumable 路徑。正式聊天不作覆蓋試驗。本文件本身不代表已執行真實環境驗收。

完成判準：對象隔離與上傳成功分界的回歸測試全過；共用 runner 成為唯一聊天上傳入口；保留舊備份與佇列讀取能力；文件明確記錄未取得跨分頁／跨裝置原子性保證。
