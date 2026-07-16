# Phase 1：Google Drive 連線層

> 規格對應：[開發手冊-v2.md](../開發手冊-v2.md) 3.1、第六章、6.1、6.2、十五-1/3
> 目標：一個穩定的 `drive.ts` 模組，上層功能只呼叫它，不直接碰 Drive REST

## 任務

### OAuth
- [x] 撰寫 GCP 設定教學文件 `docs/gcp-setup.md`：建專案 → 啟用 Drive API → OAuth 同意畫面（Testing + 測試使用者）→ 建 Web client → 登錄兩個 origin（`http://127.0.0.1:8000`、`https://esther1oooo.zeabur.app`）→ 取 Client ID
- [x] 面板加入 Client ID 輸入欄（存腳本變數）
- [x] 實作 GIS token flow：`[連線 Google Drive]` 按鈕 → 彈窗授權 → 取得 access token（scope `drive.file`）
- [x] token 過期靜默續權；失敗時面板轉「未連線」並保留待傳資料
- [x] 面板顯示已連線帳號 email（透過 Drive `about` 取得；若 scope/帳號限制取不到則顯示已連線但 email 為空）

### Drive 操作封裝（全部走 fetch + Bearer token）
- [x] `ensureFolder(path[])`：逐層 query-by-name-in-parent，不存在才建立（6.2 防重複）；回傳 folder ID
- [x] folder ID 快取於腳本變數，快取失效（404）時自動重解析
- [x] `listVersions(folderId)`：列出檔案，解析檔名 `{UTC時間}__{device}.json`，過濾不合格式者，依檔名排序
- [x] 同名資料夾多個時取聯集列版本（6.2）
- [x] `upload(folderId, filename, content)`：multipart 上傳，>5MB 改 resumable
- [x] `download(fileId)` / `delete(fileId)`
- [x] 統一錯誤層：429/5xx 指數退避重試（上限 3 次），401 觸發續權後重試一次

### 工具
- [x] UTC 時間戳產生/解析工具（`2026-06-25T14-45-00Z`），顯示轉本地時區
- [x] role_key 字元安全化函式（移除 `/` 等，保留中文）

## 驗收標準

### 自動（CI，對 mock Drive）
1. 時間戳工具：產生/解析/排序單元測試，含跨時區輸入的字典序正確性
2. role_key 安全化：中文保留、`/` 等字元移除、空字串/全非法字元的退路
3. `ensureFolder`：已存在則重用不新建；模擬兩端併發建立同名夾 → 後續 listVersions 取聯集
4. `listVersions`：檔名格式過濾（不合格式者略過）、排序、來源裝置解析
5. 錯誤層：429/5xx → 指數退避重試至上限；401 → 續權後重試一次；重試耗盡 → 拋明確錯誤
6. 上傳分流：>5MB 走 resumable（以 mock 斷言呼叫路徑）
7. folder ID 快取：404 時失效並自動重解析

### 自動（一鍵自檢，需已連線真實 Drive）
8. 真實 Drive 冒煙案例：ensureFolder → upload → listVersions → download 內容一致 → delete，全程斷言

### 手動（無法自動的理由附註）
9. 本地 A 與 Zeabur C **兩個 origin 完成真實授權**（*OAuth 彈窗需真人操作；M1 前哨，不留到最後*）
10. token revoke 後重連流程體驗（*Google 帳號端操作*）
11. 擋第三方 cookie 瀏覽器的靜默續權退化行為（*瀏覽器環境差異*）

## 風險備註
- GIS 靜默續權在擋第三方 cookie 的瀏覽器可能失敗——體驗上退化為「多點一次連線」，驗收接受此行為，但要確認佇列資料不丟
- `drive.file` scope 下，本插件看不到使用者手動放進資料夾的檔案，教學文件要提醒使用者不要手動整理 SillyTavernSync 內容（keep_all 模式下手動刪除 OK，但手動新增的檔案插件看不見）
