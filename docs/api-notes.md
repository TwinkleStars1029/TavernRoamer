# API 驗證筆記

> Phase 7 起，產品內的「系統檢查」分成安全的快速檢查與需確認的進階診斷。快速檢查不得改寫正式聊天 metadata、聊天內容、角色卡或環境資料。

## 正式 adapter 與檢查案例

| 功能 | 正式實作依賴 | 快速檢查 | 備註 |
|---|---|---|---|
| 設定 | script variables／localStorage | `settings.valid` | 唯讀；不再改寫裝置名稱 |
| 聊天讀取 | `getChatMessages`、`getVariables` | `chat.readable` | 包含訊息、swipes、變數格式 |
| 原始聊天匯出 | `POST /api/chats/export` | `chat.raw_export` | 上傳與覆蓋前還原點的必要能力；完整 JSONL 保留聊天 metadata 與每則訊息各 swipe 的 MVU `variables`／`stat_data` |
| 角色卡備份 | `getCharacter('current')` + `getCharAvatarPath('current')` + `fetch` | `environment.export.character` | 備份內嵌角色頭像圖片；無法讀取圖片時回報錯誤，避免上傳無法跨裝置完整還原的備份 |
| 世界書備份 | `loadWorldInfo` + binding APIs（舊宿主 fallback `getWorldbook`） | `environment.export.world` | 保存原始 JSON，避免助手轉換缺少 `key`／`keysecondary` 的條目時拋出 `.map()` 錯誤；角色綁定按 `{ primary, additional }` 讀取 |
| Persona 備份 | `getPersona('current')` + `getPersonaAvatarPath('current')` + `fetch` | `environment.export.persona` | 備份內嵌頭像圖片；無法讀取圖片時回報錯誤，避免上傳無法跨裝置還原的備份 |
| Preset 備份 | `getPresetManager('openai').getCompletionPresetByName()` | `environment.export.preset` | 保存 SillyTavern 原始 OpenAI preset，不經正規化，保留 prompts、prompt_order、extensions 與所有相容／供應商欄位 |
| Regex 備份 | `getTavernRegexes({ type: 'global' })` | `environment.export.regex` | 唯讀 |
| 五類環境還原 | 各 item 的 create／replace／save API | `environment.restore.*` | 快速檢查只看能力，不套用資料 |
| 從雲端建立聊天 | context characters、`selectCharacterById`、`openCharacterChat`、chat variables、角色卡 replace、聊天清單端點 | `api.chat.pull.support` | 只讀取目前角色聊天清單，不建立聊天 |
| 自動同步 | `eventOn` + 事件名稱或 fallback | `autosync.events` | 不實際觸發生成或上傳 |
| 待傳佇列 | script variable `chat_upload_queue` | `autosync.queue` | 檢查原始數量與合法項目數是否一致 |
| Google Drive | ensureFolder／upload／list／download／delete | `drive.real.smoke` | 僅寫入 `_self_check/<run_id>`，完成後清理檔案與 run folder |

## 世界書備份相容性

原生世界書備份標記為 `format: 'sillytavern-worldinfo-v1'`，每本 `books[name]` 保留包含 `entries` 的完整 JSON；還原使用 `saveWorldInfo(name, data, true)`，完成後更新世界書清單與編輯器。缺少原生讀取 API 的舊宿主仍使用 `getWorldbook`，標記為 `tavern-helper-worldbook-v1`；未標記格式的既有備份也繼續透過助手還原。讀取失敗會回報書名，不把失敗資料當成空世界書上傳。

參考：[酒館助手世界書轉換實作](https://github.com/N0VI028/JS-Slash-Runner/blob/main/src/function/worldbook.ts)、[SillyTavern context 原生世界書 API](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js)。

## Persona 頭像備份相容性

新備份以 `avatarImage` 儲存圖片 MIME 類型與 Base64 內容，還原時轉成 Blob 傳給酒館助手，避免另一台酒館找不到原本的頭像檔名。既有的純檔名備份仍可讀取，但只有目標酒館已擁有該頭像時才能完整還原；若要跨裝置還原，須在原裝置以新版腳本重新備份。

角色卡備份也以相同的 `avatarImage` 欄位保存原始頭像圖片；還原角色卡及從雲端建立缺少的角色時，都會把圖片 Blob 傳給酒館助手。舊版角色卡備份仍可讀取，但不含圖片內容；跨裝置還原原本的頭像需要在來源裝置重新備份。

## 進階診斷

| 案例 | 影響 | 保護措施 |
|---|---|---|
| `advanced.character.roundtrip` | 建立暫存角色卡 | 必須有 delete API；使用 `try/finally` 清理，清理失敗回報角色名 |
| `advanced.chat.replace.roundtrip` | 短暫改寫目前測試聊天 | 自動同步必須停用；原始 package 保留並在 `finally` 還原 |

`importRawChat` 行為探測已移出產品自檢，保留為人工相容性驗收；MemoryDrive、pack/unpack 與面板 DOM 結構由 Vitest／CI 負責。

## 目標隔離與還原資料驗證

- 非同步聊天操作固定角色 avatar、原生聊天檔名、chat_id 與 context revision；revision 可辨識 A → B → A，完成結果只在 ref、revision 與內容摘要都符合時寫入目前聊天 metadata。
- 原始 JSONL 在上傳、覆蓋與雲端拉取前逐列解析；SHA-256 正規化保留正文、swipes、變數、綁定與未知擴充欄位，只排除已知位置的 `_drive_sync` 簿記。
- 雲端拉取拆成指定角色保存與核對後開啟。保存期間切換畫面時保留已建立檔案，停止開啟與 metadata 寫入。
- 五類環境資料使用 `parseEnvironmentSnapshot()` 驗證及遷移為 `schemaVersion: 1`；未知版本／格式、損壞成員與缺少綁定資料會在本地寫入前拒絕。Regex 依名稱合併，空陣列不清空既有全域規則。
- 舊 `.json` ChatPackage 會先驗證；在尚無可證明無損的固定目標轉換路徑時拒絕套用。原始 `.jsonl` 是目前正式覆蓋格式。

## 手動聊天上傳預檢

- `ChatUploadReadinessService` 使用 `driveChatPath()` 與 `environmentItemPath()` 查詢同一個固定聊天目標；`chat/` 沒有可辨識的 `.jsonl` 才視為第一次上傳。
- `ChatUploadWorkflow` 保存 opaque preparation ID，確認前後皆由 `ChatSyncService.assertTargetCurrent()` 核對聊天 ref 與 context revision；`CHAT_CHANGED` 會使尚未執行的 preparation 失效。
- 複合操作沿用 `EnvironmentBackupService.backupItems()` 與 `ChatSyncService.uploadChat()`。缺少遠端角色卡且本次角色卡備份失敗時，預設不執行聊天上傳；其他環境項目失敗則回報部分完成。
- 手動確認頁會詢問首次環境備份，背景自動同步仍直接上傳聊天且不彈出互動 UI。

## 待真實酒館驗證

- 三個環境（本地 A、其他裝置 B、Zeabur C）各跑一次快速檢查。
- Drive smoke 在 upload、download 階段故意斷網，確認能回報殘留路徑或完成 cleanup。
- 在專用測試角色與已停用自動同步的測試聊天執行兩項進階診斷。
- 確認不同酒館助手版本的 event fallback、Preset manager 與 Persona API 行為。
- 使用去識別的 character、persona、OpenAI preset、舊 textgenerationwebui preset、world 與 regex 真實備份建立 fixture，驗證 v1／legacy roundtrip 與必要欄位矩陣。
- 驗證 `CHAT_CHANGED` 在手動切換與程式選角／開檔時的觸發順序，以及 `/api/chats/export` 是否包含尚未落盤的編輯。
- 驗證拉取保存請求送出後切換畫面時，固定 `avatar_url`／`file_name`、不開啟新畫面且不寫錯 metadata。
