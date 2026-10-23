export function injectStyle(hostDocument: Document): void {
  const existingStyle = hostDocument.querySelector<HTMLStyleElement>('#tavern-roamer-style');
  const style = existingStyle ?? hostDocument.createElement('style');
  style.id = 'tavern-roamer-style';
  style.textContent = `
    /* 預設繼承酒館主題；外觀覆寫僅作用於本面板。 */
    #tavern-roamer-panel {
      --tr-text: var(--SmartThemeBodyColor, #e7e9ef);
      --tr-background: var(--SmartThemeBlurTintColor, #181a22);
      --tr-accent-base: var(--SmartThemeQuoteColor, #8aa8ff);
      --tr-accent: var(--tr-accent-source, var(--tr-accent-base));
      --tr-surface-strength: 6%;
      --tr-border-strength: 16%;
      --tr-surface: color-mix(in srgb, currentColor var(--tr-surface-strength), transparent);
      --tr-border: color-mix(in srgb, currentColor var(--tr-border-strength), transparent);
      --tr-c-green: #5bbd7a;
      --tr-c-yellow: #d6b34a;
      --tr-c-orange: #d98a4a;
      --tr-c-red: #df7474;
      margin: 0;
      font-size: 14px;
      line-height: 1.5;
      color: var(--tr-text);
    }
    #tavern-roamer-panel[data-appearance-mode="light"] {
      --tr-text: #273244;
      --tr-background: #f7f8fb;
      --tr-accent-base: #4e6cce;
      --tr-c-green: #237340;
      --tr-c-yellow: #806000;
      --tr-c-orange: #995010;
      --tr-c-red: #b33232;
      color-scheme: light;
    }
    #tavern-roamer-panel[data-appearance-mode="dark"] {
      --tr-text: #e7e9ef;
      --tr-background: #181c26;
      --tr-accent-base: #8aa8ff;
      color-scheme: dark;
    }
    #tavern-roamer-panel[data-appearance-tone="soft"] { --tr-surface-strength: 3%; --tr-border-strength: 10%; }
    #tavern-roamer-panel[data-appearance-tone="vivid"] { --tr-surface-strength: 11%; --tr-border-strength: 28%; }
    #tavern-roamer-panel[data-appearance-mode="light"] > .inline-drawer,
    #tavern-roamer-panel[data-appearance-mode="dark"] > .inline-drawer {
      background: var(--tr-background);
      color: var(--tr-text);
      padding: 12px;
      border-radius: 10px;
    }
    #tavern-roamer-panel[data-appearance-mode="light"] > .tr-modal,
    #tavern-roamer-panel[data-appearance-mode="dark"] > .tr-modal { padding: 0; }
    #tavern-roamer-panel[data-appearance-mode="light"] .inline-drawer-header,
    #tavern-roamer-panel[data-appearance-mode="dark"] .inline-drawer-header { background: transparent; color: inherit; }
    #tavern-roamer-panel .menu_button,
    #tavern-roamer-panel .text_pole {
      color: var(--tr-text);
      background: var(--tr-surface);
      border: 1px solid var(--tr-border);
      text-shadow: none;
    }
    #tavern-roamer-panel select.text_pole option { background: var(--tr-background); color: var(--tr-text); }
    #tavern-roamer-panel input { accent-color: var(--tr-accent); }
    #tavern-roamer-panel .tr-appearance-controls { display: grid; gap: 14px; }
    #tavern-roamer-panel .tr-appearance-controls > .tr-field select { width: 100%; min-height: 42px; }
    #tavern-roamer-panel .tr-accent-presets { display: flex; flex-wrap: wrap; gap: 8px; }
    #tavern-roamer-panel .tr-swatch { display: inline-flex; align-items: center; gap: 8px; }
    #tavern-roamer-panel .tr-swatch i { width: 16px; height: 16px; border-radius: 50%; background: var(--tr-swatch); border: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-color-field { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
    #tavern-roamer-panel input[type="color"] { width: 52px; height: 38px; padding: 3px; border: 1px solid var(--tr-border); border-radius: 6px; background: var(--tr-surface); cursor: pointer; }
    #tavern-roamer-panel .tr-preview-statuses { display: flex; flex-wrap: wrap; gap: 12px; }
    #tavern-roamer-panel .tr-appearance-preview .tr-primary:disabled { opacity: 1; cursor: default; }
    #tavern-roamer-panel [data-field="appearance-feedback"] { margin: 0; }
    #tavern-roamer-panel [data-field="appearance-feedback"]:empty { display: none; }
    #tavern-roamer-panel .tr-body {
      display: grid;
      gap: 14px;
      padding: 8px 0 2px;
    }
    /* SillyTavern themes may give .menu_button a fixed square width. Keep this
       panel's text actions horizontal and let their labels determine the width. */
    #tavern-roamer-panel .menu_button {
      flex: 0 0 auto;
      width: auto !important;
      min-width: max-content;
      max-width: 100%;
      white-space: nowrap;
      writing-mode: horizontal-tb;
    }
    #tavern-roamer-panel .menu_button > span {
      white-space: nowrap;
    }
    #tavern-roamer-panel a.menu_button { text-decoration: none; }
    #tavern-roamer-panel .tr-help-link {
      width: fit-content;
      color: color-mix(in srgb, var(--tr-accent) 82%, var(--tr-text));
      font-weight: 600;
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    #tavern-roamer-panel .tr-help-link:is(:hover, :focus-visible) { color: var(--tr-accent); }
    #tavern-roamer-panel .tr-help-link > i { margin-left: 3px; font-size: .8em; }
    #tavern-roamer-panel .tr-screen {
      display: grid;
      gap: 24px;
      min-height: 0;
    }
    #tavern-roamer-panel .tr-screen[hidden] { display: none !important; }
    #tavern-roamer-panel :is(.tr-home-actions, .tr-connect-guide, .tr-current-card, .tr-home-progress-lock)[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }
    #tavern-roamer-panel .tr-current-card,
    #tavern-roamer-panel .tr-summary-card {
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-muted,
    #tavern-roamer-panel .tr-summary-card span { opacity: .84; }
    #tavern-roamer-panel .tr-connection-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; background: var(--tr-border); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tr-border) 70%, transparent); }
    #tavern-roamer-panel .tr-connection-dot.is-connected { background: var(--tr-c-green); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tr-c-green) 18%, transparent); }
    #tavern-roamer-panel .tr-current-card { display: grid; min-width: 0; overflow: hidden; }
    #tavern-roamer-panel [data-field="home-current-content"] { min-width: 0; }
    #tavern-roamer-panel .tr-current-main {
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      min-width: 0;
      padding: 18px;
    }
    #tavern-roamer-panel .tr-current-avatar {
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--tr-accent) 18%, var(--tr-surface));
      color: var(--tr-accent);
      font-size: 20px;
      font-weight: 700;
    }
    #tavern-roamer-panel .tr-current-details { display: grid; gap: 3px; min-width: 0; }
    #tavern-roamer-panel .tr-current-details > b { font-size: 16px; }
    #tavern-roamer-panel .tr-current-filename { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .84; }
    #tavern-roamer-panel .tr-current-status { display: grid; justify-items: start; gap: 7px; margin-top: 5px; }
    #tavern-roamer-panel .tr-current-meta { display: flex; flex-wrap: wrap; gap: 3px 8px; min-width: 0; margin: 0; font-size: 12px; opacity: .84; }
    #tavern-roamer-panel .tr-current-meta > span + span::before { content: '·'; margin-right: 8px; }
    #tavern-roamer-panel .tr-current-cta { display: grid; justify-items: stretch; gap: 4px; min-width: 0; }
    #tavern-roamer-panel .tr-current-action { display: grid; justify-items: stretch; gap: 4px; }
    #tavern-roamer-panel .tr-current-action small { max-width: 180px; text-align: center; opacity: .84; }
    #tavern-roamer-panel .tr-current-meta [data-field="queue-segment"] { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
    #tavern-roamer-panel .tr-current-meta .tr-queue-flush { min-height: 0; margin: 0; padding: 2px 8px; font-size: 12px; }
    #tavern-roamer-panel .tr-current-feedback { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-current-feedback:empty { display: none; }
    #tavern-roamer-panel .tr-current-warning { display: flex; align-items: flex-start; gap: 7px; max-width: 220px; margin: 0; font-size: 13px; }
    #tavern-roamer-panel .tr-current-warning > i { margin-top: .2em; color: var(--tr-c-orange); }
    #tavern-roamer-panel .tr-callout[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-current-empty { display: flex; align-items: center; gap: 7px; max-width: 210px; margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-summary-card { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: hidden; }
    #tavern-roamer-panel .tr-summary-card { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #tavern-roamer-panel .tr-cloud-filename { overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-summary-card > div { display: grid; gap: 5px; padding: 14px 16px; border-right: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-summary-card > div:nth-child(even) { border-right: 0; }
    #tavern-roamer-panel .tr-home-actions { display: grid; gap: 18px; }
    #tavern-roamer-panel .tr-connect-guide {
      display: grid;
      gap: 16px;
      padding: 18px;
      border: 1px solid color-mix(in srgb, var(--tr-accent) 34%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--tr-accent) 10%, transparent);
    }
    #tavern-roamer-panel .tr-connect-guide-head { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; align-items: start; }
    #tavern-roamer-panel .tr-connect-guide-head > i { margin-top: 3px; color: var(--tr-accent); font-size: 22px; }
    #tavern-roamer-panel .tr-connect-guide h3 { margin: 0; font-size: 18px; }
    #tavern-roamer-panel .tr-connect-guide p { margin: 3px 0 0; opacity: .84; }
    #tavern-roamer-panel .tr-connect-steps { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    #tavern-roamer-panel .tr-connect-steps li { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 10px; }
    #tavern-roamer-panel .tr-connect-steps li > span { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--tr-border); border-radius: 50%; background: var(--tr-surface); font-weight: 700; }
    #tavern-roamer-panel .tr-connect-steps li > div { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
    #tavern-roamer-panel .tr-connect-guide > .menu_button { justify-self: start; }
    #tavern-roamer-panel .tr-task-section { display: grid; gap: 9px; }
    #tavern-roamer-panel .tr-task-section-head { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-task-section-head h3 { margin: 0; font-size: 16px; }
    #tavern-roamer-panel .tr-task-section-head p { margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-task-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    #tavern-roamer-panel .tr-task-card {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 12px;
      padding: 15px 16px;
      min-height: 76px;
      text-align: left;
      color: inherit;
      background: var(--tr-surface);
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      cursor: pointer;
    }
    #tavern-roamer-panel .tr-task-card:hover { border-color: var(--tr-accent); background: color-mix(in srgb, var(--tr-accent) 12%, transparent); }
    #tavern-roamer-panel :is(.tr-task-card, .menu_button, .tr-cloud-role, .tr-cloud-pull, .text_pole, input, summary):focus-visible,
    #tavern-roamer-panel .tr-choice-row:focus-within {
      outline: 3px solid var(--tr-accent);
      outline-offset: 3px;
    }
    #tavern-roamer-panel .tr-task-card > i:first-child { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 9px; background: color-mix(in srgb, var(--tr-accent) 18%, transparent); color: var(--tr-accent); font-size: 17px; }
    #tavern-roamer-panel .tr-task-card span { display: grid; gap: 3px; }
    #tavern-roamer-panel .tr-task-card b { font-size: 14px; }
    #tavern-roamer-panel .tr-task-card small { opacity: .84; font-size: 12px; }
    #tavern-roamer-panel .tr-environment-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    #tavern-roamer-panel .tr-secondary-task { min-height: 40px; }
    #tavern-roamer-panel .tr-home-progress-lock { margin: -4px 0 0; padding: 9px 12px; border-radius: 8px; background: color-mix(in srgb, var(--tr-c-yellow) 12%, transparent); color: var(--tr-text); }
    #tavern-roamer-panel .tr-operation-banner {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px 12px;
      padding: 11px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--tr-accent) 34%, transparent);
      background: color-mix(in srgb, var(--tr-accent) 11%, transparent);
    }
    #tavern-roamer-panel .tr-operation-summary { display: flex; align-items: center; gap: 8px; min-width: 0; }
    #tavern-roamer-panel .tr-operation-summary b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tavern-roamer-panel .tr-operation-banner > .menu_button { grid-column: 2; grid-row: 1; }
    #tavern-roamer-panel .tr-progress-resume-bar { grid-column: 1 / -1; grid-row: 2; height: 4px; }
    #tavern-roamer-panel .tr-operation-banner[hidden],
    #tavern-roamer-panel .tr-preview-retry[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-step-heading { display: grid; gap: 4px; }
    #tavern-roamer-panel .tr-step-heading h2 { margin: 2px 0 0; font-size: 21px; }
    /* 頁面標題只接受程式化焦點供讀屏宣告，不是操作控制，不顯示按鈕式焦點框。 */
    #tavern-roamer-panel .tr-step-heading h2:focus { outline: none; }
    #tavern-roamer-panel .tr-step-heading p { margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-step-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .86; }
    #tavern-roamer-panel .tr-step-dots { display: flex; gap: 5px; }
    #tavern-roamer-panel .tr-step-dots i { width: 26px; height: 4px; border-radius: 99px; background: var(--tr-border); }
    #tavern-roamer-panel .tr-step-dots i.is-active { background: var(--tr-accent); }
    #tavern-roamer-panel .tr-callout {
      padding: 11px 14px;
      border: 0;
      border-left: 3px solid color-mix(in srgb, var(--tr-accent) 72%, var(--tr-text));
      border-radius: 0 8px 8px 0;
      background: color-mix(in srgb, var(--tr-accent) 9%, transparent);
    }
    #tavern-roamer-panel .tr-callout.tr-danger {
      border-left-color: color-mix(in srgb, var(--tr-c-orange) 78%, var(--tr-text));
      background: color-mix(in srgb, var(--tr-c-orange) 10%, transparent);
    }
    #tavern-roamer-panel .tr-inline-note {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      align-items: start;
      gap: 8px;
      padding: 10px 12px;
      border-left: 3px solid color-mix(in srgb, var(--tr-accent) 68%, var(--tr-text));
      border-radius: 0 7px 7px 0;
      background: color-mix(in srgb, var(--tr-accent) 7%, transparent);
    }
    #tavern-roamer-panel .tr-inline-note > i { margin-top: .22em; color: var(--tr-accent); }
    #tavern-roamer-panel .tr-danger-button { border-color: color-mix(in srgb, var(--tr-c-red) 50%, var(--tr-border)); }
    #tavern-roamer-panel .tr-danger-button:not(:disabled):hover { background: color-mix(in srgb, var(--tr-c-red) 15%, transparent); }
    #tavern-roamer-panel .tr-step-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-step-footer > div { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; justify-content: flex-end; }
    #tavern-roamer-panel .tr-step-footer [hidden] { display: none !important; }
    #tavern-roamer-panel .tr-step-footer > div:empty { display: none; }
    #tavern-roamer-panel .tr-choice-list {
      display: grid;
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--tr-border);
      border-radius: 12px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-choice-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 12px 14px;
      border: 0;
      border-radius: 0;
      background: transparent;
      cursor: pointer;
      transition: background-color 160ms ease;
    }
    #tavern-roamer-panel .tr-choice-row + .tr-choice-row { border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-choice-row:is(:hover, :focus-within) { background: color-mix(in srgb, var(--tr-accent) 9%, transparent); }
    #tavern-roamer-panel .tr-choice-row:focus-within { outline-offset: -3px; }
    #tavern-roamer-panel .tr-choice-row span { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-choice-row small { opacity: .84; }
    #tavern-roamer-panel .tr-choice-title { display: flex !important; align-items: center; flex-wrap: wrap; gap: 6px !important; }
    #tavern-roamer-panel .tr-choice-badge { padding: 1px 7px; border-radius: 999px; color: var(--tr-accent); background: color-mix(in srgb, var(--tr-accent) 12%, transparent); font-size: 11px; font-style: normal; font-weight: 700; }
    #tavern-roamer-panel .tr-choice-row.is-required {
      box-shadow: inset 3px 0 color-mix(in srgb, var(--tr-c-orange) 72%, var(--tr-text));
      background: color-mix(in srgb, var(--tr-c-orange) 6%, transparent);
    }
    #tavern-roamer-panel .tr-choice-row.is-required:is(:hover, :focus-within) {
      background: color-mix(in srgb, var(--tr-c-orange) 10%, transparent);
    }
    #tavern-roamer-panel .tr-choice-row.is-required .tr-choice-badge { color: var(--tr-c-orange); background: color-mix(in srgb, var(--tr-c-orange) 13%, transparent); }
    #tavern-roamer-panel .tr-choice-version { overflow-wrap: anywhere; font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
    #tavern-roamer-panel .tr-choice-row > i { color: var(--tr-c-green); }
    #tavern-roamer-panel .tr-choice-row input:not(:checked) ~ i { visibility: hidden; }
    #tavern-roamer-panel .tr-restore-preview,
    #tavern-roamer-panel .tr-preview-group { display: grid; gap: 8px; }
    #tavern-roamer-panel .tr-preview-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) max-content; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--tr-c-green) 10%, transparent); }
    #tavern-roamer-panel .tr-preview-row > span { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-preview-filename {
      opacity: .84;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-preview-row.is-skipped { background: var(--tr-surface); }
    #tavern-roamer-panel .tr-restore-toolbar {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(140px, .55fr) auto;
      align-items: end;
      gap: 10px;
    }
    #tavern-roamer-panel .tr-restore-toolbar .tr-field { margin: 0; }
    #tavern-roamer-panel .tr-restore-toolbar .menu_button { min-height: 44px; }
    #tavern-roamer-panel .tr-restore-point-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    #tavern-roamer-panel .tr-restore-point-actions .menu_button,
    #tavern-roamer-panel .tr-restore-selection .menu_button { min-width: 0; min-height: 44px; white-space: normal; }
    #tavern-roamer-panel .tr-restore-point-actions .menu_button > span,
    #tavern-roamer-panel .tr-restore-selection .menu_button > span { white-space: normal; }
    #tavern-roamer-panel .tr-restore-selection {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px 16px;
      padding: 10px 12px;
      border: 1px solid var(--tr-border);
      border-radius: 9px;
      background: var(--tr-background);
    }
    #tavern-roamer-panel .tr-restore-selection[hidden] { display: none !important; }
    #tavern-roamer-panel .tr-restore-selection label { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; }
    #tavern-roamer-panel .tr-restore-selection [data-field="restore-selection-count"] { flex: 1 1 130px; }
    #tavern-roamer-panel .tr-restore-advanced { position: relative; }
    #tavern-roamer-panel .tr-restore-advanced summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; opacity: .82; }
    #tavern-roamer-panel .tr-restore-advanced[open] { flex-basis: 100%; display: grid; gap: 8px; }
    #tavern-roamer-panel .tr-restore-point-feedback { margin: 0; min-height: 1.5em; }
    #tavern-roamer-panel .tr-restore-point-feedback:empty { display: none; }
    #tavern-roamer-panel .tr-restore-cleanup-card,
    #tavern-roamer-panel .tr-restore-detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-background);
    }
    #tavern-roamer-panel .tr-restore-cleanup-card > div:first-child,
    #tavern-roamer-panel .tr-restore-detail-head > div:first-child { display: grid; gap: 3px; }
    #tavern-roamer-panel .tr-restore-cleanup-card small,
    #tavern-roamer-panel .tr-restore-detail-head small { opacity: .78; }
    #tavern-roamer-panel .tr-restore-chat-list { display: grid; gap: 8px; margin-top: 12px; }
    #tavern-roamer-panel .tr-restore-chat-card {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content auto;
      align-items: center;
      gap: 14px;
      min-height: 66px;
      padding: 12px 14px;
      color: inherit;
      text-align: left;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
      cursor: pointer;
    }
    #tavern-roamer-panel .tr-restore-chat-card:hover { border-color: var(--tr-accent); }
    #tavern-roamer-panel .tr-restore-chat-card:focus-visible { outline: 3px solid var(--tr-accent); outline-offset: 2px; }
    #tavern-roamer-panel .tr-restore-chat-main,
    #tavern-roamer-panel .tr-restore-chat-meta { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-restore-chat-main b { overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-restore-chat-main small,
    #tavern-roamer-panel .tr-restore-chat-meta small { opacity: .74; }
    #tavern-roamer-panel .tr-restore-chat-main em { color: var(--tr-c-orange); font-size: 11px; font-style: normal; }
    #tavern-roamer-panel .tr-restore-chat-meta { text-align: right; white-space: nowrap; }
    #tavern-roamer-panel .tr-back-inline { width: fit-content; min-height: 44px; margin-bottom: 10px; }
    #tavern-roamer-panel .tr-restore-detail-head h3 { margin: 0; overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-restore-detail-select { padding: 8px 2px; }
    #tavern-roamer-panel .tr-restore-detail-select label { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; }
    #tavern-roamer-panel .tr-restore-point-list,
    #tavern-roamer-panel .tr-restore-batch,
    #tavern-roamer-panel .tr-restore-files { display: grid; gap: 10px; }
    #tavern-roamer-panel .tr-restore-batch {
      padding: 12px;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-restore-batch-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    #tavern-roamer-panel .tr-restore-batch-head > div { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-restore-batch-head small { opacity: .78; }
    #tavern-roamer-panel .tr-restore-technical { position: relative; flex: 0 0 auto; }
    #tavern-roamer-panel .tr-restore-technical summary {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 44px;
      padding: 0 8px;
      border-radius: 7px;
      opacity: .78;
      cursor: pointer;
      user-select: none;
    }
    #tavern-roamer-panel .tr-restore-technical summary:hover { opacity: 1; background: var(--tr-background); }
    #tavern-roamer-panel .tr-restore-technical summary:focus-visible { outline: 3px solid var(--tr-accent); outline-offset: 2px; }
    #tavern-roamer-panel .tr-restore-technical-content {
      display: grid;
      gap: 10px;
      margin-top: 8px;
      padding: 12px;
      border: 1px solid var(--tr-border);
      border-radius: 8px;
      background: var(--tr-background);
    }
    #tavern-roamer-panel .tr-restore-batch-head .tr-restore-technical[open] { flex-basis: 100%; }
    #tavern-roamer-panel .tr-restore-technical-row { display: grid; grid-template-columns: minmax(108px, .3fr) minmax(0, 1fr); gap: 8px 14px; align-items: baseline; }
    #tavern-roamer-panel .tr-restore-technical-row small { opacity: .72; }
    #tavern-roamer-panel .tr-restore-technical-row code { overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    #tavern-roamer-panel .tr-restore-technical-group { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-restore-issues { display: flex; flex-wrap: wrap; gap: 6px; }
    #tavern-roamer-panel .tr-restore-issues span { display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border-radius: 999px; color: var(--tr-c-orange); background: color-mix(in srgb, var(--tr-c-orange) 12%, transparent); font-size: 11px; }
    #tavern-roamer-panel .tr-restore-file {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      min-height: 54px;
      padding: 10px 12px;
      border: 1px solid var(--tr-border);
      border-radius: 8px;
      cursor: pointer;
    }
    #tavern-roamer-panel .tr-restore-file:hover { border-color: var(--tr-accent); }
    #tavern-roamer-panel .tr-restore-file.is-empty { cursor: default; opacity: .78; }
    #tavern-roamer-panel .tr-restore-file.is-empty:hover { border-color: var(--tr-border); }
    #tavern-roamer-panel .tr-restore-file:focus-within { outline: 3px solid var(--tr-accent); outline-offset: 2px; }
    #tavern-roamer-panel .tr-restore-file-main { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-restore-file-main > span { overflow-wrap: anywhere; font-size: 12px; line-height: 1.4; opacity: .82; }
    #tavern-roamer-panel .tr-progress-state { display: flex; align-items: center; gap: 10px; font-size: 17px; }
    #tavern-roamer-panel .tr-state-success { color: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-state-warning { color: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-state-error { color: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-state-neutral { opacity: .8; }
    #tavern-roamer-panel .tr-section {
      display: grid;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-section-title {
      font-weight: 600;
      opacity: .82;
      border-bottom: 1px solid var(--tr-border);
      padding-bottom: 4px;
    }
    #tavern-roamer-panel .tr-section-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    #tavern-roamer-panel .tr-section-icon {
      transition: transform .15s ease;
    }
    #tavern-roamer-panel .tr-section-icon.tr-collapsed {
      transform: rotate(-90deg);
    }
    #tavern-roamer-panel .tr-grid {
      display: grid;
      grid-template-columns: minmax(90px, max-content) minmax(0, 1fr);
      gap: 6px 12px;
      align-items: baseline;
    }
    #tavern-roamer-panel .tr-grid span,
    #tavern-roamer-panel .tr-field > span,
    #tavern-roamer-panel .tr-fieldset legend {
      opacity: .84;
    }
    #tavern-roamer-panel .tr-grid b {
      font-weight: 600;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    /* 狀態色點 pill：文字吃主題色，顏色由色點呈現，低飽和且暗亮主題皆可讀 */
    #tavern-roamer-panel .tr-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    #tavern-roamer-panel .tr-pill::before {
      content: '';
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--tr-tone, #9aa0a6);
      flex: 0 0 auto;
    }
    #tavern-roamer-panel .tr-tone-green { --tr-tone: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-tone-yellow { --tr-tone: var(--tr-c-yellow, #d6b34a); }
    #tavern-roamer-panel .tr-tone-orange { --tr-tone: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-tone-red { --tr-tone: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-tone-grey { --tr-tone: var(--tr-c-grey, #9aa0a6); }
    #tavern-roamer-panel .tr-warn-text {
      color: var(--tr-c-orange, #d98a4a);
      font-weight: 700;
    }
    #tavern-roamer-panel .tr-guidance {
      margin: 0;
      padding: 8px 10px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--tr-c-yellow, #d6b34a) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-c-yellow, #d6b34a) 40%, transparent);
      opacity: .95;
    }
    #tavern-roamer-panel .tr-field {
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-inline {
      grid-template-columns: minmax(120px, max-content) minmax(72px, 120px);
      align-items: center;
    }
    #tavern-roamer-panel .tr-fieldset {
      margin: 0;
      padding: 8px 10px;
      border: 1px solid var(--tr-border);
      border-radius: 6px;
      display: grid;
      gap: 6px;
    }
    #tavern-roamer-panel .tr-settings-content {
      display: grid;
      gap: 10px;
    }
    #tavern-roamer-panel .tr-settings-content[hidden] {
      display: none;
    }
    #tavern-roamer-panel .tr-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    #tavern-roamer-panel .tr-self-check-panel {
      display: grid;
      gap: 12px;
      margin-top: 4px;
      padding: 14px;
      border: 1px solid var(--tr-border);
      border-radius: 10px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-self-check-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
    }
    #tavern-roamer-panel .tr-self-check-head > div:first-child { display: grid; gap: 4px; }
    #tavern-roamer-panel .tr-self-check-head small { opacity: .84; max-width: 620px; }
    #tavern-roamer-panel .tr-self-check-results,
    #tavern-roamer-panel .tr-check-groups { display: grid; gap: 10px; }
    #tavern-roamer-panel .tr-check-empty { margin: 0; opacity: .84; }
    #tavern-roamer-panel .tr-check-running,
    #tavern-roamer-panel .tr-check-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--tr-accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-accent) 28%, transparent);
    }
    #tavern-roamer-panel .tr-check-running { justify-content: flex-start; }
    #tavern-roamer-panel .tr-check-running > span { display: flex; justify-content: space-between; gap: 12px; width: 100%; }
    #tavern-roamer-panel .tr-check-summary-copy { display: grid; gap: 2px; }
    #tavern-roamer-panel .tr-check-summary-copy small { font-size: 12px; opacity: .86; }
    #tavern-roamer-panel .tr-check-summary-success { border-color: color-mix(in srgb, var(--tr-c-green, #5bbd7a) 34%, transparent); }
    #tavern-roamer-panel .tr-check-summary-warning { border-color: color-mix(in srgb, var(--tr-c-orange, #d98a4a) 38%, transparent); }
    #tavern-roamer-panel .tr-check-summary-error { border-color: color-mix(in srgb, var(--tr-c-red, #d05a5a) 38%, transparent); }
    #tavern-roamer-panel .tr-check-group { display: grid; gap: 6px; }
    #tavern-roamer-panel .tr-check-group h3 { margin: 0; font-size: 14px; opacity: .86; }
    #tavern-roamer-panel .tr-check-group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
    #tavern-roamer-panel .tr-check-row {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
      padding: 9px 10px;
      border-radius: 7px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-check-icon { padding-top: 1px; text-align: center; }
    #tavern-roamer-panel .tr-check-pass .tr-check-icon { color: var(--tr-c-green, #5bbd7a); }
    #tavern-roamer-panel .tr-check-fail .tr-check-icon { color: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-check-blocked .tr-check-icon { color: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-check-not_applicable .tr-check-icon { opacity: .58; }
    #tavern-roamer-panel .tr-check-copy { display: grid; gap: 2px; min-width: 0; }
    #tavern-roamer-panel .tr-check-copy small { overflow-wrap: anywhere; }
    #tavern-roamer-panel .tr-check-remediation { opacity: .86; }
    #tavern-roamer-panel .tr-check-action { align-self: center; }
    #tavern-roamer-panel .tr-check-details { grid-column: 2 / -1; font-size: 12px; opacity: .86; }
    #tavern-roamer-panel .tr-check-details summary { cursor: pointer; }
    #tavern-roamer-panel .tr-check-details pre {
      margin: 6px 0 0;
      padding: 8px;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: 6px;
      background: var(--black30a, rgba(0, 0, 0, .2));
    }
    #tavern-roamer-panel .tr-disabled,
    #tavern-roamer-panel .menu_button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }
    /* 進度清單 */
    #tavern-roamer-panel .tr-progress {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--tr-border);
      border-radius: 6px;
    }
    /* 作者規則會蓋過 UA 的 [hidden]{display:none}，需明確補回，否則空進度框仍會顯示 */
    #tavern-roamer-panel .tr-progress[hidden] {
      display: none;
    }
    #tavern-roamer-panel .tr-progress-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-weight: 600;
    }
    #tavern-roamer-panel .tr-progress-count {
      opacity: .84;
      font-variant-numeric: tabular-nums;
    }
    #tavern-roamer-panel .tr-progressbar {
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: var(--tr-border);
    }
    #tavern-roamer-panel .tr-progressbar > i {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: var(--tr-accent);
      transition: width .2s ease;
    }
    #tavern-roamer-panel .tr-progressbar-warning > i { background: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-progressbar-error > i { background: var(--tr-c-red, #d05a5a); }
    #tavern-roamer-panel .tr-progressbar-neutral > i { background: var(--tr-c-grey, #9aa0a6); }
    #tavern-roamer-panel .tr-progress-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    #tavern-roamer-panel .tr-progress-row {
      display: grid;
      grid-template-columns: 18px minmax(56px, max-content) minmax(0, 1fr) max-content;
      gap: 8px;
      align-items: center;
    }
    #tavern-roamer-panel .tr-upload-complete {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-top: 4px;
      padding: 10px 12px;
      border-radius: 7px;
      color: var(--tr-c-green, #5bbd7a);
      background: color-mix(in srgb, var(--tr-c-green, #5bbd7a) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--tr-c-green, #5bbd7a) 28%, transparent);
    }
    #tavern-roamer-panel .tr-row-detail {
      opacity: .86;
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-row-icon { text-align: center; }
    #tavern-roamer-panel .tr-ok { color: var(--tr-c-green, #5bbd7a); font-weight: 700; }
    #tavern-roamer-panel .tr-err { color: var(--tr-c-red, #d05a5a); font-weight: 700; }
    #tavern-roamer-panel .tr-abort { color: var(--tr-c-orange, #d98a4a); font-weight: 700; }
    #tavern-roamer-panel .tr-queued { color: var(--tr-c-orange, #d98a4a); }
    #tavern-roamer-panel .tr-dot { opacity: .5; }
    #tavern-roamer-panel .tr-retry {
      padding: 2px 8px;
      font-size: 12px;
    }
    #tavern-roamer-panel .tr-cloud {
      display: grid;
      gap: 12px;
    }
    #tavern-roamer-panel .tr-cloud[hidden] { display: none; }
    #tavern-roamer-panel .tr-cloud-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 2px;
      font-weight: 600;
    }
    #tavern-roamer-panel .tr-cloud-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--tr-border);
      border-radius: 12px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-cloud-list > li {
      min-width: 0;
    }
    #tavern-roamer-panel .tr-cloud-list > li + li { border-top: 1px solid var(--tr-border); }
    #tavern-roamer-panel .tr-cloud-role {
      width: 100% !important;
      min-width: 0;
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 12px 14px;
      text-align: left;
    }
    #tavern-roamer-panel .tr-cloud-role > span {
      min-width: 0;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    #tavern-roamer-panel .tr-cloud-role-chevron { opacity: .58; font-size: 12px; }
    #tavern-roamer-panel .tr-cloud-chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content max-content;
      gap: 8px;
      align-items: center;
      min-height: 64px;
      padding: 12px 14px;
    }
    #tavern-roamer-panel .tr-cloud-chat-id {
      min-width: 0;
      overflow-wrap: anywhere;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-cloud-chat-info {
      opacity: .84;
      font-size: 12px;
      white-space: nowrap;
    }
    #tavern-roamer-panel .tr-cloud-empty {
      margin: 0;
      padding: 14px;
      opacity: .84;
    }
    #tavern-roamer-panel .tr-report {
      margin: 0;
      white-space: pre-wrap;
      overflow: auto;
      max-height: 180px;
      padding: 8px;
      border-radius: 6px;
      background: var(--black30a, rgba(0, 0, 0, .2));
      color: var(--tr-text);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #tavern-roamer-panel .tr-report:empty { display: none; }

    /* 浮動保底：掛到 body（iframe 自身 document）時酒館的元件 class 與主題變數
       不存在，需一組 scoped 保底樣式，只在 .tr-floating 下生效。 */
    #tavern-roamer-panel.tr-floating {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left)) !important;
      background: rgba(8, 10, 18, 0.72);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
    }
    #tavern-roamer-panel .tr-modal {
      width: min(1080px, calc(100vw - 48px));
      max-height: calc(100vh - 48px);
      max-height: calc(100dvh - 48px);
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--tr-border);
      background:
        linear-gradient(180deg, color-mix(in srgb, currentColor 8%, transparent), transparent 140px),
        var(--tr-background);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
      overflow: hidden;
    }
    #tavern-roamer-panel .tr-modal-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--tr-border);
      cursor: default;
    }
    #tavern-roamer-panel .tr-kicker {
      margin-bottom: 4px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.84;
    }
    #tavern-roamer-panel .tr-title {
      font-size: 22px;
      line-height: 1.1;
    }
    #tavern-roamer-panel .tr-modal-content {
      display: block;
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding: 16px 20px 20px;
    }
    #tavern-roamer-panel .tr-header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
      min-width: 0;
    }
    #tavern-roamer-panel .tr-connection-button {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0 !important;
      max-width: min(220px, 38vw);
    }
    #tavern-roamer-panel .tr-connection-button > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tavern-roamer-panel .tr-close {
      flex: 0 0 auto;
      min-width: 72px;
      width: auto;
      min-height: 34px;
      justify-content: center;
      padding: 6px 14px;
      white-space: nowrap;
      writing-mode: horizontal-tb;
      line-height: 1.2;
    }
    #tavern-roamer-panel.tr-floating .menu_button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--tr-border);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: inherit;
      background: var(--tr-surface);
      font-size: 13px;
      min-height: 42px;
    }
    #tavern-roamer-panel.tr-floating .text_pole {
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      border-radius: 6px;
      border: 1px solid var(--tr-border);
      padding: 6px 8px;
      background: var(--tr-surface);
      color: inherit;
    }
    #tavern-roamer-panel.tr-floating .checkbox_label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #tavern-roamer-panel.tr-floating .checkbox_label input {
      width: auto;
    }
    #tavern-roamer-panel .menu_button:is(:hover, [aria-pressed="true"], .tr-primary) {
      background: color-mix(in srgb, var(--tr-accent) 22%, var(--tr-background));
      border-color: var(--tr-accent);
    }
    #tavern-roamer-panel .menu_button.tr-cloud-role {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) 14px;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 12px 14px;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      touch-action: manipulation;
      transition: background-color 160ms ease;
    }
    #tavern-roamer-panel .menu_button.tr-cloud-role:is(:hover, :focus-visible) {
      border-color: transparent;
      background: color-mix(in srgb, var(--tr-accent) 10%, transparent);
    }
    #tavern-roamer-panel .menu_button.tr-cloud-role:focus-visible { outline-offset: -3px; }
    #tavern-roamer-panel .tr-upload-overview {
      overflow: hidden;
      border: 1px solid var(--tr-border);
      border-radius: 12px;
      background: var(--tr-surface);
    }
    #tavern-roamer-panel .tr-upload-overview > .tr-summary-card {
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    #tavern-roamer-panel .tr-upload-overview [data-field="upload-preview"] {
      display: grid;
      gap: 12px;
      padding: 12px 0 16px;
      border-top: 1px solid var(--tr-border);
    }
    #tavern-roamer-panel .tr-upload-overview [data-field="upload-preview"] > :not(.tr-upload-cloud-summary) {
      margin-inline: 16px;
    }
    #tavern-roamer-panel .tr-upload-cloud-summary {
      display: grid;
      gap: 5px;
      min-width: 0;
      padding: 4px 16px;
    }
    #tavern-roamer-panel .tr-upload-cloud-summary > span { opacity: .84; }
    @media (max-width: 640px) {
      #tavern-roamer-panel.tr-floating {
        align-items: flex-start;
        padding: max(12px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)) !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
      }
      #tavern-roamer-panel .tr-modal {
        flex: 0 0 auto;
        width: 100%;
        max-height: none;
        border-radius: 8px;
      }
      #tavern-roamer-panel .tr-modal-header {
        flex-shrink: 0;
        flex-wrap: wrap;
        align-items: center;
        padding: 12px 14px 10px;
      }
      #tavern-roamer-panel .tr-kicker {
        margin-bottom: 2px;
      }
      #tavern-roamer-panel .tr-title {
        font-size: 19px;
      }
      #tavern-roamer-panel .tr-close {
        min-width: 64px;
      }
      #tavern-roamer-panel .tr-modal-content {
        flex: 0 0 auto;
        overflow: visible;
        padding: 12px 14px 16px;
      }
      #tavern-roamer-panel .tr-task-grid,
      #tavern-roamer-panel .tr-summary-card { grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-summary-card > div { border-right: 0; border-bottom: 1px solid var(--tr-border); }
      #tavern-roamer-panel .tr-summary-card > div:last-child { border-bottom: 0; }
      #tavern-roamer-panel .tr-current-main { grid-template-columns: 48px minmax(0, 1fr); padding: 16px; }
      #tavern-roamer-panel .tr-current-avatar { width: 48px; height: 48px; }
      #tavern-roamer-panel .tr-current-cta { grid-column: 1 / -1; width: 100%; }
      #tavern-roamer-panel .tr-current-cta > .menu_button,
      #tavern-roamer-panel .tr-current-action,
      #tavern-roamer-panel .tr-current-action > .menu_button { width: 100% !important; }
      #tavern-roamer-panel .tr-current-action small,
      #tavern-roamer-panel .tr-current-warning { max-width: none; }
      #tavern-roamer-panel .tr-preview-row { grid-template-columns: 20px minmax(0, 1fr); }
      #tavern-roamer-panel .tr-preview-row > small { grid-column: 2; }
      #tavern-roamer-panel .tr-header-actions .tr-icon-button span { display: none; }
      #tavern-roamer-panel .tr-cloud-chat-row {
        grid-template-columns: minmax(0, 1fr) max-content;
      }
      #tavern-roamer-panel .tr-cloud-chat-info {
        grid-column: 1 / -1;
        grid-row: 2;
        white-space: normal;
      }
      #tavern-roamer-panel .tr-self-check-head,
      #tavern-roamer-panel .tr-check-summary { align-items: stretch; flex-direction: column; }
      #tavern-roamer-panel .tr-restore-toolbar { grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-restore-cleanup-card,
      #tavern-roamer-panel .tr-restore-detail-head { align-items: stretch; flex-direction: column; }
      #tavern-roamer-panel .tr-restore-chat-card { grid-template-columns: minmax(0, 1fr) auto; }
      #tavern-roamer-panel .tr-restore-chat-meta { grid-column: 1; grid-row: 2; text-align: left; white-space: normal; }
      #tavern-roamer-panel .tr-restore-chat-card > i { grid-column: 2; grid-row: 1 / 3; }
      #tavern-roamer-panel .tr-restore-file { grid-template-columns: auto minmax(0, 1fr); }
      #tavern-roamer-panel .tr-restore-batch-head { align-items: stretch; flex-direction: column; }
      #tavern-roamer-panel .tr-restore-technical { width: 100%; }
      #tavern-roamer-panel .tr-restore-technical summary { width: fit-content; }
      #tavern-roamer-panel .tr-restore-technical-row { grid-template-columns: 1fr; gap: 2px; }
      #tavern-roamer-panel .tr-check-row { grid-template-columns: 20px minmax(0, 1fr); }
      #tavern-roamer-panel .tr-check-action { grid-column: 2; justify-self: start; }
    }
    @media (max-width: 480px) {
      #tavern-roamer-panel .tr-operation-banner { grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-operation-banner > .menu_button { grid-column: 1; grid-row: 3; width: 100% !important; }
      #tavern-roamer-panel .tr-progress-resume-bar { grid-column: 1; grid-row: 2; }
      #tavern-roamer-panel .tr-connect-guide > .menu_button { justify-self: stretch; width: 100% !important; }
      #tavern-roamer-panel .tr-environment-actions { display: grid; grid-template-columns: 1fr; }
      #tavern-roamer-panel .tr-environment-actions > .menu_button { width: 100% !important; }
      #tavern-roamer-panel .tr-step-footer {
        flex-wrap: wrap;
        align-items: stretch;
      }
      #tavern-roamer-panel .tr-step-footer > div {
        flex: 1 1 180px;
      }
      #tavern-roamer-panel .tr-step-footer > div > .menu_button {
        width: 100% !important;
      }
      #tavern-roamer-panel .tr-step-footer .menu_button,
      #tavern-roamer-panel .tr-step-footer .menu_button > span {
        min-width: 0;
        min-height: 44px;
        white-space: normal;
        overflow-wrap: anywhere;
      }
    }
    @media (max-width: 360px) {
      #tavern-roamer-panel .tr-header-actions { gap: 6px; }
      #tavern-roamer-panel .tr-connection-button { max-width: 132px; }
      #tavern-roamer-panel .tr-current-main { grid-template-columns: 42px minmax(0, 1fr); gap: 10px; padding: 14px; }
      #tavern-roamer-panel .tr-current-avatar { width: 42px; height: 42px; font-size: 17px; }
      #tavern-roamer-panel .tr-current-meta { display: grid; gap: 2px; }
      #tavern-roamer-panel .tr-current-meta > span + span::before { content: none; }
      #tavern-roamer-panel .tr-step-footer {
        flex-direction: column;
      }
      #tavern-roamer-panel .tr-step-footer > .menu_button,
      #tavern-roamer-panel .tr-step-footer > div {
        width: 100% !important;
      }
      #tavern-roamer-panel .tr-step-footer > div {
        flex-basis: auto;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #tavern-roamer-panel *,
      #tavern-roamer-panel *::before,
      #tavern-roamer-panel *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
      }
    }
  `;
  if (!existingStyle) {
    hostDocument.head.append(style);
  }
}

