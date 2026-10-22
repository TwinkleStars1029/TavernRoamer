# TavernRoamer

SillyTavern Google Drive Chat ID Sync 的 Tavern Helper / JS-Slash-Runner 腳本工程。

## 開發

```bash
pnpm install
pnpm verify
```

打包輸出位於 `dist/tavern-roamer.js`。建立 GitHub repo 後，酒館助手腳本庫可使用 jsDelivr 類似連結：

```text
https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/dist/tavern-roamer.js
```

Phase 0 的真實酒館自檢入口在面板右上角的 `自檢` 按鈕。

## 首次上傳與跨裝置環境

手動上傳聊天時，TavernRoamer 會先檢查該聊天在 Drive 上的聊天版本與環境備份。第一次上傳，或既有聊天缺少角色卡備份時，確認頁會詢問是否一起備份環境：角色卡與缺少的世界書預設勾選，Persona、Preset、Regex 預設不勾選，避免未經明確選擇上傳個人設定。

「備份所選環境並上傳」會先備份環境、再上傳聊天；缺少角色卡且角色卡備份失敗時，聊天不會自動上傳。「只上傳聊天」仍可使用，但會再次提示其他裝置可能無法建立這段聊天。背景自動同步不彈出視窗，之後可從手動上傳確認頁補齊缺少的角色卡。

## 外觀設定

點選面板頂部「首頁」與「關閉」之間的「樣式」，可切換跟隨酒館、淺色或深色模式，選擇預設／自訂強調色，並調整柔和、標準或鮮明色調。所有頁面會即時預覽，按「儲存外觀」後保留；返回上一頁或關閉面板會取消尚未儲存的變更。「重設為跟隨酒館」也需儲存才會保留。

配色只作用於 TavernRoamer 面板，成功、警告與錯誤保留辨識色。外觀與連線設定分別儲存，修改外觀不會連帶儲存尚未提交的連線欄位。

## 專案架構

`src/index.ts` 是 composition root，負責建立 Drive、聊天同步、環境備份、自檢與 UI，並把操作以 callback 注入面板。主要目錄如下：

```text
src/
├─ app/             # 應用層使用的 SillyTavern shell／診斷介面
├─ chat/            # 聊天同步、拉取、佇列與 feature-owned ports
├─ drive/           # Google Drive client 與檔案服務
├─ environment/     # 環境備份／還原與 export/apply ports
├─ tavern/          # SillyTavern globals、原生 API 與具體 adapters
├─ ui/              # 面板 controller、views、DOM host、樣式與格式化
├─ contextRevision.ts # 跨非同步步驟辨識聊天／角色切換的單調 revision
├─ selfCheck.ts     # 可注入 Tavern ports 的系統檢查案例
├─ tavern.ts        # Tavern 相容 façade
└─ ui.ts            # UI 相容 façade
```

依賴方向為 `index.ts → application services / UI / Tavern adapters`。聊天與環境服務只依賴各自的窄介面；UI 透過 `PanelOptions` 接收設定、自檢與同步操作，不直接存取 Tavern 或應用服務。聊天 JSONL 的解析／摘要集中在 `chat/snapshot.ts`，五類環境備份的 runtime schema 與 legacy 遷移集中在 `environment/validation.ts`，所有正式還原入口共用這兩道驗證邊界。
