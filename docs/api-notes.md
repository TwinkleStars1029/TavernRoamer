# API 驗證筆記

Phase 0 先建立自檢案例與記錄格式。以下項目需要在真實酒館內按「自檢」後補上結果。

| 項目 | 自檢案例 | 目前狀態 | 備註 |
|---|---|---|---|
| `getCharacter()` / `createOrReplaceCharacter()` | `api.character.roundtrip` | 待真實酒館執行 | 驗證完整 JSON、頭像、卡內正則、`extensions` |
| `getChatHistoryBrief()` + `getChatHistoryDetail()` | `api.chat.detail` | 待真實酒館執行 | 若 API 不存在，自檢會記錄替代 API 狀態 |
| `importRawChat()` | `api.chat.importRawChat` | 待真實酒館執行 | 記錄實際匯入後檔名規則 |
| chat 變數讀寫 | `api.chat.variables` | 待真實酒館執行 | 驗證 `_drive_sync` 可寫入且可讀回 |
| `getPreset('in_use')` | `api.preset.inUse` | 待真實酒館執行 | 驗證當前預設讀取 |
| `getTavernRegexes()` | `api.regex.global` | 待真實酒館執行 | 驗證全域正則讀取 |
| worldbook 系列 | `api.worldbook.available` | 待真實酒館執行 | Phase 0 先檢查 API 可用性 |

## 與文件不符處

- 尚未執行真實酒館自檢，暫無結論。
