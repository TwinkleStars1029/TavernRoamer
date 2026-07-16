# Google Cloud / Drive API 設定教學

本專案使用瀏覽器端 Google Identity Services token flow，scope 固定為：

```text
https://www.googleapis.com/auth/drive.file
```

這個 scope 只允許 TavernRoamer 存取自己建立或由使用者透過本 app 選取的 Drive 檔案。請不要手動把檔案塞進 `SillyTavernSync` 期望插件讀到；`drive.file` 模式下，手動新增的檔案通常不會被本插件看見。手動刪除本插件建立的舊版本則可以。

## 1. 建立 Google Cloud 專案

1. 開啟 Google Cloud Console。
2. 建立新專案，例如 `TavernRoamer Sync`。
3. 確認畫面上方目前選中的專案就是剛建立的專案。

## 2. 啟用 Google Drive API

1. 進入 `APIs & Services` → `Library`。
2. 搜尋 `Google Drive API`。
3. 點進去後按 `Enable`。

## 3. 設定 OAuth 同意畫面

1. 進入 `APIs & Services` → `OAuth consent screen`。
2. User Type 選 `External`。
3. Publishing status 保持 `Testing`。
4. 填入 app 名稱、使用者支援 email、開發者聯絡 email。
5. Scopes 加入：

```text
https://www.googleapis.com/auth/drive.file
```

6. Test users 加入實際使用 TavernRoamer 的 Google 帳號。

## 4. 建立 Web OAuth Client

1. 進入 `APIs & Services` → `Credentials`。
2. 點 `Create credentials` → `OAuth client ID`。
3. Application type 選 `Web application`。
4. Authorized JavaScript origins 加入：

```text
http://127.0.0.1:8000
https://esther1oooo.zeabur.app
```

如本地酒館使用 `localhost` 而不是 `127.0.0.1`，也加上：

```text
http://localhost:8000
```

5. 建立後複製 `Client ID`。

## 5. 填入 TavernRoamer

1. 在 SillyTavern 開啟 Extensions 設定面板。
2. 找到 TavernRoamer。
3. 將 `Google Client ID` 貼入欄位並按 `儲存設定`。
4. 按 `連線 Google Drive`，用剛加入 Test users 的帳號授權。

## 6. 驗收提醒

- A 本機與 C Zeabur 是不同 origin，兩邊都要各自實測一次授權。
- token 約 1 小時會過期；TavernRoamer 會先嘗試靜默續權，若瀏覽器阻擋第三方 cookie，可能需要重新按一次連線。
- 若在 Google 帳號安全設定中 revoke app 權限，下一次操作應回到未連線狀態，重新按連線即可。

## 7. 疑難排解：授權後顯示 popup_closed

如果 Google 授權視窗完成操作後，TavernRoamer 顯示：

```text
Google OAuth 視窗已關閉，尚未完成授權
```

請打開瀏覽器 Console，查看 `[TavernRoamer OAuth] env:connect:headers`。若看到：

```json
{"coop":"same-origin"}
```

代表 SillyTavern server 送出的 `Cross-Origin-Opener-Policy: same-origin` 讓主頁進入獨立 browsing context group。Google Identity Services popup 跳到 `accounts.google.com` 後，授權結果無法傳回 opener，因此 GIS 會回報 `popup_closed`。這不是 Google Client ID 填錯，前端也無法繞過。

最快驗證方式是在 SillyTavern 安裝目錄搜尋設定 header 的位置：

```bash
grep -rn "Cross-Origin-Opener-Policy" --include="*.js" --include="*.mjs" .
grep -rn "same-origin" server.js src/
```

Windows PowerShell 可用：

```powershell
Get-ChildItem -Recurse -Include *.js,*.mjs | Select-String -Pattern "Cross-Origin-Opener-Policy","same-origin"
```

找到後將：

```js
res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
```

改成：

```js
res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
```

或暫時註解該 header。改完後重啟 SillyTavern，對頁面做硬重新整理（例如 `Ctrl+Shift+R`），再確認 `env:connect:headers` 裡的 `coop` 變成 `same-origin-allow-popups` 或 `null`。

若 SillyTavern 版本提供安全 header 相關設定開關，優先使用設定開關，避免手改 server 程式在升級時被覆蓋。
