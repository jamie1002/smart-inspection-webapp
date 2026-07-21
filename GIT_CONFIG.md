# Git / GitHub 配置狀況

> 給協助此專案的 AI／開發者參考，避免重新猜測環境設定。最後更新：2026-07-22

## 倉庫資訊

- GitHub: `jamie1002/smart-inspection-webapp`（public，非 fork）
- Remote URL: `https://github.com/jamie1002/smart-inspection-webapp.git`
- 預設分支：`main`
- `main` 之外還有一個 `gh-pages` 分支，僅供 `npm run deploy`（`gh-pages` npm 套件）自動
  推送建置產物，**不要手動改這個分支的內容**，也不需要對它開 PR/review。
- 沒有 branch protection rule，沒有 `.github/workflows`（無 CI/CD）
- Collaborators：僅 `jamie1002` 一人

## 部署（GitHub Pages）

- `npm run deploy` 一次建正式版＋測試版兩份 bundle、合併進同一個 `dist/`、
  推到 `gh-pages` 分支；GitHub Pages 設定為以 `gh-pages` 分支發布。
- 部署後有三個同時可達的網址（一般＝正式版／`test/`＝測試版／`test/?debug`＝校正工具），
  細節與歷史沿革見 `docs/00_前端專案總覽與規格書.md` §2、§9.7（曾經 `deploy`／
  `deploy:test` 共用同一分支互相覆蓋，2026-07-22 已修正）。
- `deploy:test` 現在只是 `deploy` 的別名，兩者行為完全相同。

## 本機環境

- 作業系統：Windows 11，殼層為 PowerShell（`Bash` 工具走 Git Bash / POSIX sh）
- Git 帳號設定（global）：
  - `user.name = Jamie`
  - `user.email = s6950gb@gmail.com`
- `core.autocrlf = true`、`core.filemode = false`、`core.symlinks = false`（Windows 預設行為，`git add` 時常見 "LF will be replaced by CRLF" 警告，屬正常現象，可忽略）
- 認證：透過 `gh auth login` 完成，`gh auth status` 顯示已登入 `jamie1002`，protocol 為 https，token scopes 含 `repo`、`workflow`、`read:org`、`gist`
- Push/Pull 目前使用 `gh`/`git` 皆可直接操作，不需額外輸入密碼

## 提交慣例

- Commit message 使用中文，第一行為簡短標題，空行後接條列式重點說明（`- ` 開頭），描述改了什麼、為什麼改
- 目前尚未使用 PR 流程，都是直接 commit 到 `main` 再視情況 push
- 沒有 pre-commit hook／lint-staged 等強制檢查

## .gitignore 重點

- 標準 Node/Vite 忽略項：`node_modules`、`dist`、`dist-ssr`、`*.local`、各種 log
- 編輯器：`.vscode/*`（保留 `extensions.json`）、`.idea`
- 專案特有：`_coco_source/`（Roboflow COCO 標註原始素材，非程式碼，不進版控）
- `前端修改規格_交接單.md`：單次協作/交接用的工作文件，內容會隨每次交接改寫、
  不是長期維護的規格，故不進版控。**長期規格請寫進 `docs/`（進版控）**，
  交接單只是「這次要做什麼」的暫時清單，做完就可能整份重寫或作廢。
- 本檔（`GIT_CONFIG.md`）本身**要進版控**，不要加進 `.gitignore`。

## 給 AI 的提醒

1. 這台機器的終端機工具在直接輸入中文/多行 commit message 時容易出狀況（編碼或跳脫字元問題），**用 heredoc（`git commit -m "$(cat <<'EOF' ... EOF)"`）** 比較穩定。
2. 沒有 CI，push 到 `main` 不會觸發任何自動化流程，純粹是遠端備份，沒有 branch protection 擋不住直接 push。
3. `gh` CLI 已認證好，可直接用於建立 PR / issue / 查repo 資訊，不需要再要求使用者登入。
4. 目前只有單一開發者、單一分支，不需要考慮多人協作衝突或 PR review 流程，除非使用者另外說明。
