/**
 * @fileoverview ナレッジ自動配分システム（v4.1 詳細ログ＆トレーサビリティ強化版）
 * @description NotebookLMで生成された構造化テキストを、Googleドライブ内の
 *              適切なGoogleドキュメントへ自動的に追記・更新するシステム。
 *
 * ⚠️ セットアップ:
 *   1. スクリプト設定 → ランタイム → V8 を有効にすること
 *   2. CONFIG の BUFFER_DOC_ID を実際のドキュメントIDに書き換えること
 *
 * [v4.1 変更点]
 *   ① DocEditor.applyBlock() が { isFound, success } を返すよう変更
 *      → ブロックループで各結果を blockResults[] に蓄積できるようになった
 *   ② TransferLogger.logDetailed(info) を新設
 *      → [SUCCESS]/[ERROR]・ファイル・セクション・詳細・バックアップ名を
 *         複数行フォーマットで ログファイル ドキュメントに記録する
 *   ③ main() の後処理フローを微調整
 *      → バックアップ作成後にファイル名を取得し logDetailed に渡す
 *   ④ v4.0 のコアロジック（_normalizeText, _parseHeader, BackupManager）は無変更
 *
 * 処理フロー（v4.1 確定版）:
 *   1. インボックスをパース
 *   2. 全ブロックをループ処理し、各結果 (isFound / success) を blockResults[] に保持
 *   3. 全件成功時:
 *      a. バックアップを作成し、ファイル名を取得
 *      b. インボックスをクリア
 *      c. バックアップ名を含む詳細ログを ログファイル に1件ずつ書き出す
 *      d. 7日以上前の古いバックアップを削除
 *   4. 失敗が1件でもある場合: バックアップ・クリアをスキップして詳細ログのみ記録
 *
 * @version 4.1.0
 */

// ============================================================
// 設定定数
// ============================================================

/**
 * @const {Object} CONFIG システム全体の設定
 * @property {string} ROOT_FOLDER_NAME   - ドライブのルートフォルダ名
 * @property {string} BUFFER_DOC_ID      - バッファドキュメントのID（要変更）
 * @property {string} BUFFER_DOC_NAME    - ログ・バックアップで使用する表示名
 * @property {number} BACKUP_RETAIN_DAYS - バックアップ保持日数（超過分は自動削除）
 */
const CONFIG = {
  ROOT_FOLDER_NAME  : 'SF6_攻略マスター(NotebookLM)',
  BUFFER_DOC_ID     : '1uEpGU9UGvvAH9jnFBIA9FHvlKqLKQaZvMlcjZmbTcDI', // ← ここを実際のIDに変更
  BUFFER_DOC_NAME   : '0_0インボックス',
  BACKUP_RETAIN_DAYS: 7,
};

// ============================================================
// エントリーポイント
// ============================================================

/**
 * メイン処理。GASエディタの「実行」ボタンからこの関数を呼び出す。
 *
 * [v4.1 の変更点]
 * - 各ブロックの処理結果を blockResults[] に蓄積する
 * - バックアップ作成後に backupName を取得して logDetailed() に渡す
 * - ログファイル への記録は詳細フォーマット (logDetailed) に移行
 */
function main() {
  Logger.log('=== ナレッジ自動配分システム v4.1 開始 ===');

  let bufferDoc = null;

  try {

    // ── STEP 1: インボックス取得とパース ─────────────────────────
    bufferDoc = DocumentApp.openById(CONFIG.BUFFER_DOC_ID);
    const bufferText = bufferDoc.getBody().getText();
    Logger.log(`インボックス取得: "${bufferDoc.getName()}"`);

    const parser = new Parser();
    const blocks = parser.parseBlocks(bufferText);
    Logger.log(`パース完了: ${blocks.length} 件のブロックを検出`);

    if (blocks.length === 0) {
      Logger.log('処理対象ブロックがありません。終了します。');
      return;
    }

    // ── STEP 2: 全ブロックをループ処理し結果を蓄積 ───────────────
    const fileManager = new FileManager(CONFIG.ROOT_FOLDER_NAME);
    /** @type {Object.<string, DocEditor>} 同一ファイルへの複数操作をキャッシュ */
    const editorCache = {};

    let successCount = 0;
    let failCount    = 0;

    /**
     * @typedef  {Object} BlockResult
     * @property {Object}  block     - 元のブロックデータ（targetFile, targetSection, action）
     * @property {boolean} isFound   - セクションがドキュメント内に存在したか
     * @property {boolean} success   - 処理が成功したか
     * @property {string}  [errorMsg] - 失敗時のエラーメッセージ
     */
    /** @type {BlockResult[]} */
    const blockResults = [];

    blocks.forEach((block, i) => {
      Logger.log(`\n--- ブロック ${i + 1}/${blocks.length} ---`);
      Logger.log(`  Target File   : ${block.targetFile}`);
      Logger.log(`  Target Section: ${block.targetSection}`);
      Logger.log(`  Action        : ${block.action}`);

      try {
        if (!editorCache[block.targetFile]) {
          const doc = fileManager.getTargetDoc(block.targetFile);
          editorCache[block.targetFile] = new DocEditor(doc, parser);
        }

        // ① applyBlock() が { isFound, success } を返す
        const result = editorCache[block.targetFile].applyBlock(block);

        Logger.log(`  ✅ 成功 (isFound: ${result.isFound})`);
        successCount++;
        blockResults.push({ block, isFound: result.isFound, success: true });

      } catch (err) {
        Logger.log(`  ❌ 失敗: ${err.message}`);
        Logger.log(`     スタック: ${err.stack}`);
        failCount++;
        blockResults.push({ block, isFound: false, success: false, errorMsg: err.message });
      }
    });

    Logger.log(
      `\n=== 処理結果: 成功 ${successCount} / 失敗 ${failCount} / 合計 ${blocks.length} ===`
    );

    // ── STEP 3: 後処理 ──────────────────────────────────────────
    if (failCount === 0 && successCount > 0) {

      // 3a. バックアップ作成 → ファイル名を取得して後続処理に渡す
      const backupName = BackupManager.createBackup(
        fileManager, CONFIG.BUFFER_DOC_ID, CONFIG.BUFFER_DOC_NAME
      );

      // 3b. インボックスをクリア（バックアップが成功した後でのみ実行）
      _clearBufferDoc(bufferDoc);

      // 3c. 詳細ログを ログファイル に1件ずつ書き出す
      TransferLogger.logDetailed(fileManager, blockResults, backupName);

      // 3d. 7日以上前の古いバックアップを削除
      BackupManager.deleteOldBackups(fileManager, CONFIG.BACKUP_RETAIN_DAYS);

    } else if (failCount > 0) {
      Logger.log(
        `\n⚠️ [後処理スキップ]\n` +
        `  失敗が ${failCount} 件あるため、バックアップ・クリアをスキップしました。\n` +
        `  失敗ブロックを確認・修正してから再実行してください。`
      );
      // 失敗時もログには全件の結果（SUCCESS/ERROR）を記録する
      TransferLogger.logDetailed(fileManager, blockResults, null);
    }

  } catch (err) {
    Logger.log(`❌ システムエラー: ${err.message}\n${err.stack}`);
  }
}

/**
 * バッファドキュメントの本文を全消去して空の状態にする。
 * GAS の仕様上 clear() 後も空段落が1つ残るが、運用上問題ない。
 *
 * @param {GoogleAppsScript.Document.Document} doc クリア対象
 */
function _clearBufferDoc(doc) {
  try {
    doc.getBody().clear();
    Logger.log('🗑️  インボックスをクリアしました。');
  } catch (err) {
    Logger.log(`⚠️ インボックスクリアに失敗: ${err.message}`);
  }
}

// ============================================================
// BackupManager クラス（v4.0 から継承・createBackup の戻り値のみ追加）
// ============================================================

/**
 * @class BackupManager
 * @description バックアップの作成・古いバックアップの自動削除を担当するクラス。
 *
 * バックアップはルートフォルダ内の「Backups」サブフォルダに保存される。
 * フォルダが存在しない場合は自動作成する。
 * ファイル名: `[Backup] {bufferDocName}_{yyyyMMdd_HHmm}`
 */
class BackupManager {

  /**
   * バックアップフォルダ名を返す。
   * ⚠️ GAS では「static PROP = 値」構文がエラーになるため static get() を使用。
   *
   * @static
   * @returns {string}
   */
  static get BACKUP_FOLDER_NAME() { return 'Backups'; }

  /**
   * バッファドキュメントを Backups フォルダへコピーしてバックアップを作成する。
   *
   * [v4.1 変更点] 作成したバックアップのファイル名を戻り値として返す。
   *              → main() が backupName を取得して logDetailed() に渡せるようになる。
   *
   * @static
   * @param {FileManager} fileManager  FileManager インスタンス
   * @param {string}      bufferDocId  バッファドキュメントの DriveファイルID
   * @param {string}      bufferDocName バックアップファイル名に使用する表示名
   * @returns {string} 作成されたバックアップファイルの名前
   * @throws {Error} バックアップ作成に失敗した場合（クリアを中断させるため再スロー）
   */
  static createBackup(fileManager, bufferDocId, bufferDocName) {
    const backupsFolder = BackupManager._getOrCreateBackupsFolder(fileManager);
    const dateStr = Utilities.formatDate(
      new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm'
    );
    const backupName = `[Backup] ${bufferDocName}_${dateStr}`;

    try {
      const sourceFile = DriveApp.getFileById(bufferDocId);
      const backup     = sourceFile.makeCopy(backupName, backupsFolder);
      Logger.log(`📦 バックアップ作成: "${backup.getName()}" (ID: ${backup.getId()})`);
      return backup.getName(); // ← v4.1 追加: 作成されたファイル名を返す
    } catch (err) {
      Logger.log(`⚠️ バックアップ作成に失敗しました: ${err.message}`);
      throw err; // クリア前なので再スローしてクリアを中断させる
    }
  }

  /**
   * Backups フォルダ内の「作成から retainDays 日以上経過したファイル」を
   * ゴミ箱に移動する（完全削除ではなく Trash 移動で安全性を確保）。
   *
   * @static
   * @param {FileManager} fileManager FileManager インスタンス
   * @param {number}      retainDays  保持日数
   */
  static deleteOldBackups(fileManager, retainDays) {
    try {
      const backupsFolder = BackupManager._getOrCreateBackupsFolder(fileManager);
      const threshold     = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);

      const iter = backupsFolder.getFiles();
      let deletedCount = 0;

      while (iter.hasNext()) {
        const file = iter.next();
        if (file.getDateCreated() < threshold) {
          Logger.log(
            `  🗑️ 古いバックアップを削除: "${file.getName()}"` +
            ` (作成日: ${Utilities.formatDate(
              file.getDateCreated(), Session.getScriptTimeZone(), 'yyyy/MM/dd'
            )})`
          );
          file.setTrashed(true);
          deletedCount++;
        }
      }

      Logger.log(
        deletedCount === 0
          ? `  古いバックアップなし（${retainDays}日以内のみ保持）`
          : `  古いバックアップ削除完了: ${deletedCount} 件`
      );

    } catch (err) {
      Logger.log(`⚠️ 古いバックアップ削除に失敗: ${err.message}`);
    }
  }

  /**
   * ルートフォルダ配下の「Backups」フォルダを取得、または新規作成する。
   *
   * @private
   * @static
   * @param {FileManager} fileManager
   * @returns {GoogleAppsScript.Drive.Folder}
   */
  static _getOrCreateBackupsFolder(fileManager) {
    const rootFolder = fileManager.getRootFolder();
    const name       = BackupManager.BACKUP_FOLDER_NAME;
    const iter       = rootFolder.getFoldersByName(name);
    if (iter.hasNext()) return iter.next();
    Logger.log(`  📁 "${name}" フォルダを新規作成`);
    return rootFolder.createFolder(name);
  }
}

// ============================================================
// TransferLogger クラス（v4.1 で logDetailed() を新設）
// ============================================================

/**
 * @class TransferLogger
 * @description 処理結果をルートフォルダ内の「ログファイル」ドキュメントに記録するクラス。
 *              v4.1 では logDetailed() メソッドで詳細フォーマットの記録に対応した。
 */
class TransferLogger {

  /**
   * ログドキュメントのファイル名を返す。
   * ⚠️ GAS では「static PROP = 値」構文がエラーになるため static get() を使用。
   *
   * @static
   * @returns {string}
   */
  static get LOG_FILE_NAME() { return 'ログファイル'; }

  /**
   * 全ブロックの処理結果を詳細フォーマットで ログファイル ドキュメントに追記する。
   *
   * 出力フォーマット（1ブロックにつき1エントリ）:
   * ─────────────────────────────────
   * [yyyy/MM/dd HH:mm:ss] [SUCCESS or ERROR]
   * ・ファイル   : {targetFile}
   * ・セクション : "{targetSection}"
   * ・詳細       : {action} ({処理詳細テキスト})
   * ・バックアップ: {backupName} または "（スキップ）"
   * ─────────────────────────────────
   *
   * @static
   * @param {FileManager}   fileManager  FileManager インスタンス
   * @param {BlockResult[]} blockResults 全ブロックの処理結果配列
   * @param {string|null}   backupName   作成されたバックアップ名（失敗時は null）
   */
  static logDetailed(fileManager, blockResults, backupName) {
    if (!blockResults || blockResults.length === 0) return;

    try {
      const rootFolder = fileManager.getRootFolder();
      const logDoc     = TransferLogger._getOrCreateLogDoc(rootFolder);
      const body       = logDoc.getBody();

      const dateStr = Utilities.formatDate(
        new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss'
      );

      // 区切り線（視認性のためエントリ群の前に挿入）
      body.appendParagraph('─'.repeat(40));

      blockResults.forEach((br) => {
        const statusLabel  = br.success ? '[SUCCESS]' : '[ERROR]';
        const backupLabel  = backupName || '（スキップ）';

        // isFound に応じて「既存セクションを更新」か「末尾に新規追加」かを判別
        const detailText = br.success
          ? (br.isFound
              ? `${br.block.action} (既存セクションを更新)`
              : `${br.block.action} (セクションが見つからず末尾に新規追加)`)
          : `${br.block.action} (ERROR: ${br.errorMsg || '不明なエラー'})`;

        // ── エントリの書き込み ─────────────────────────────────────
        // 1行目: タイムスタンプ + ステータス（見出し2スタイルで視認性UP）
        const headerPara = body.appendParagraph(`${dateStr} ${statusLabel}`);
        headerPara.setHeading(DocumentApp.ParagraphHeading.HEADING2);

        // 2行目以降: 詳細情報（通常段落）
        body.appendParagraph(`・ファイル    : ${br.block.targetFile}`);
        body.appendParagraph(`・セクション  : "${br.block.targetSection}"`);
        body.appendParagraph(`・詳細        : ${detailText}`);
        body.appendParagraph(`・バックアップ: ${backupLabel}`);
        body.appendParagraph(''); // 空行

        Logger.log(
          `  📝 詳細ログ追記:\n` +
          `     ${dateStr} ${statusLabel}\n` +
          `     ファイル: ${br.block.targetFile}\n` +
          `     セクション: "${br.block.targetSection}"\n` +
          `     詳細: ${detailText}\n` +
          `     バックアップ: ${backupLabel}`
        );
      });

      Logger.log(`  ログファイル 詳細記録完了（${blockResults.length} 件）`);

    } catch (err) {
      Logger.log(`  ⚠️ ログファイル への記録に失敗: ${err.message}`);
    }
  }

  /**
   * ルートフォルダ内の ログファイル ドキュメントを取得、または新規作成する。
   *
   * @private
   * @static
   * @param {GoogleAppsScript.Drive.Folder} rootFolder
   * @returns {GoogleAppsScript.Document.Document}
   */
  static _getOrCreateLogDoc(rootFolder) {
    const name = TransferLogger.LOG_FILE_NAME;
    const iter = rootFolder.getFilesByName(name);
    if (iter.hasNext()) return DocumentApp.openById(iter.next().getId());

    // 新規作成: DocumentApp.create はマイドライブのルートに生成されるため moveTo で移動
    const newDoc = DocumentApp.create(name);
    DriveApp.getFileById(newDoc.getId()).moveTo(rootFolder);

    const body   = newDoc.getBody();
    const header = body.insertParagraph(0, '=== Transfer Log ===');
    header.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph('');

    Logger.log(`  📄 "${name}" を新規作成しました`);
    return newDoc;
  }
}

// ============================================================
// Parser クラス（v4.0 から無変更）
// ============================================================

/**
 * @class Parser
 * @description バッファドキュメントのテキストを解析するクラス。
 *              ブロック分割・ヘッダーパース・Markdownトークナイズを担当。
 */
class Parser {

  // ----------------------------------------------------------
  // ブロックパース
  // ----------------------------------------------------------

  /**
   * テキスト全体から更新ブロックを抽出する。
   *
   * 方式: 「行ベースのセパレータ位置リスト」（v3.0 で確立）
   *   1. 全行スキャンしてセパレータ行（10文字以上の - or =）の行番号を収集
   *   2. セパレータ2本で1ブロックを構成
   *   3. Array.slice でヘッダー行・コンテンツ行を切り出して処理
   *
   * @param {string} text バッファドキュメントの全文
   * @returns {Array<{targetFile:string, targetSection:string, action:string, reason:string, content:string}>}
   */
  parseBlocks(text) {
    const lines       = text.split('\n');
    const SEP_LINE_RE = /^[ \t]*[-=]{10,}[ \t]*$/;

    const sepIndices = lines.reduce((acc, line, i) => {
      if (SEP_LINE_RE.test(line)) acc.push(i);
      return acc;
    }, []);

    Logger.log(
      `  セパレータ行 ${sepIndices.length} 個検出` +
      (sepIndices.length > 0 ? ` (行: ${sepIndices.join(', ')})` : '')
    );

    if (sepIndices.length < 2) {
      Logger.log('  ⚠️ セパレータが2個未満のため、処理対象ブロックなし。');
      return [];
    }

    const blocks = [];

    for (let s = 0; s + 1 < sepIndices.length; s += 2) {
      const headerStart  = sepIndices[s] + 1;
      const headerEnd    = sepIndices[s + 1];
      const contentStart = sepIndices[s + 1] + 1;
      const contentEnd   = (s + 2 < sepIndices.length) ? sepIndices[s + 2] : lines.length;

      Logger.log(
        `  ブロック候補 ${Math.floor(s / 2) + 1}:` +
        ` ヘッダー行=${headerStart}-${headerEnd - 1}` +
        ` コンテンツ行=${contentStart}-${contentEnd - 1}`
      );

      const headerText  = lines.slice(headerStart, headerEnd).join('\n').trim();
      const contentText = lines.slice(contentStart, contentEnd).join('\n').trim();

      const meta = this._parseHeader(headerText);
      if (!meta) continue;

      meta.content = this._extractMarkdown(contentText);
      if (!meta.content) {
        Logger.log(`  ⚠️ コンテンツが空のブロックをスキップ: [${meta.targetSection}]`);
        continue;
      }

      blocks.push(meta);
    }

    return blocks;
  }

  /**
   * ヘッダーテキストをパースしてメタデータを返す。
   *
   * 方式: \r?\n で行ごとに分割してから1行ずつスキャンする（v4.0 で確立）。
   * これにより隣接するタグの値が混入することは構造上起きない。
   *
   * @private
   * @param {string} headerText ヘッダー文字列（複数行）
   * @returns {{targetFile:string, targetSection:string, action:string, reason:string}|null}
   */
  _parseHeader(headerText) {
    const fieldMap = {};
    const lines    = headerText.split(/\r?\n/);

    for (const line of lines) {
      const m = line.match(/^\[([^\]]+)\]\s*(.*)/);
      if (!m) continue;
      const key   = m[1].trim();
      const value = m[2].trim(); // 行末の \r や空白を除去
      if (value) fieldMap[key] = value;
    }

    const targetFile    = fieldMap['Target File']    || null;
    const targetSection = fieldMap['Target Section'] || null;
    const actionRaw     = fieldMap['Action']         || null;

    if (!targetFile || !targetSection || !actionRaw) {
      const missing = [
        !targetFile    && '[Target File]',
        !targetSection && '[Target Section]',
        !actionRaw     && '[Action]',
      ].filter(Boolean).join(', ');

      Logger.log(
        `  ⚠️ ヘッダーパース失敗（必須フィールド不足: ${missing}）\n` +
        `     ヘッダー: "${headerText.substring(0, 100).replace(/\n/g, ' ')}"`
      );
      return null;
    }

    const action = actionRaw.split(/[\s/]+/)[0].toUpperCase();

    return {
      targetFile,
      targetSection,
      action,
      reason: fieldMap['Reason'] || '',
    };
  }

  /**
   * コンテンツ部からMarkdownテキストのみを取り出す。
   * ``` または ```markdown フェンスがある場合はその内側を返す。
   *
   * @private
   * @param {string} contentText
   * @returns {string}
   */
  _extractMarkdown(contentText) {
    const fenceMatch = contentText.match(/^```(?:markdown)?\s*\n([\s\S]*?)```\s*$/m);
    return fenceMatch ? fenceMatch[1].trim() : contentText;
  }

  // ----------------------------------------------------------
  // Markdownトークナイズ
  // ----------------------------------------------------------

  /**
   * MarkdownテキストをDocEditorが処理できるトークン配列に変換する。
   *
   * トークン種別:
   *   - heading   : { type, level, text }
   *   - listItem  : { type, nestingLevel, text, ordered }
   *   - table     : { type, rows: string[][] }
   *   - paragraph : { type, text }
   *   - blank     : { type }
   *
   * @param {string} markdown
   * @returns {Array<Object>}
   */
  tokenize(markdown) {
    const lines  = markdown.split('\n');
    const tokens = [];
    let tableLines = [];
    let inTable    = false;

    const flushTable = () => {
      if (tableLines.length > 0) {
        const result = this._parseTableLines(tableLines);
        if (result) tokens.push({ type: 'table', rows: result });
        tableLines = [];
      }
      inTable = false;
    };

    for (const line of lines) {

      if (line.trim().startsWith('|')) {
        inTable = true;
        if (!/^\|[\s\-:|]+\|$/.test(line.trim())) tableLines.push(line);
        continue;
      }
      if (inTable) flushTable();

      const hMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (hMatch) {
        tokens.push({ type: 'heading', level: hMatch[1].length, text: hMatch[2].trim() });
        continue;
      }

      const ulMatch = line.match(/^(\s*)([-*+])\s+(.+)/);
      if (ulMatch) {
        tokens.push({
          type: 'listItem',
          nestingLevel: Math.floor(ulMatch[1].length / 2),
          text: ulMatch[3].trim(),
          ordered: false,
        });
        continue;
      }

      const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (olMatch) {
        tokens.push({
          type: 'listItem',
          nestingLevel: Math.floor(olMatch[1].length / 2),
          text: olMatch[3].trim(),
          ordered: true,
        });
        continue;
      }

      if (line.trim() === '') { tokens.push({ type: 'blank' }); continue; }

      tokens.push({ type: 'paragraph', text: line });
    }

    if (inTable) flushTable();
    return tokens;
  }

  /**
   * Markdownの表行配列を2次元配列に変換する。列数不一致は空セルで補完。
   *
   * @private
   * @param {string[]} lines
   * @returns {string[][]|null}
   */
  _parseTableLines(lines) {
    if (lines.length === 0) return null;

    const parsed    = lines.map((row) =>
      row.split('|').slice(1, -1).map((cell) => cell.trim())
    );
    const colCounts = parsed.map((r) => r.length);
    const maxCols   = Math.max(...colCounts);
    const minCols   = Math.min(...colCounts);

    if (maxCols !== minCols) {
      const info = colCounts
        .map((c, i) => (c !== maxCols ? `行${i + 1}:${c}列` : null))
        .filter(Boolean).join(', ');
      Logger.log(
        `  ⚠️ [表パース警告] 列数不一致（基準:${maxCols}列 / 不一致:${info}）。空セルで補完。`
      );
      parsed.forEach((row) => { while (row.length < maxCols) row.push(''); });
    }

    return parsed;
  }

  // ----------------------------------------------------------
  // インラインテキスト解析（静的ユーティリティ）
  // ----------------------------------------------------------

  /**
   * インラインMarkdown記法を解析し、スタイル付きセグメント配列を返す。
   *
   * 対応記法:
   *   1. `**テキスト**` → bold
   *   2. `*テキスト*` または `_テキスト_` → italic
   *
   * @static
   * @param {string} text
   * @returns {Array<{text:string, bold:boolean, italic:boolean}>}
   */
  static parseInlineStyles(text) {
    const segments    = [];
    const inlineRegex = /(\*\*([^\n*][^\n]*?)\*\*)|(\*([^\n*]+?)\*)|(_([^\n_]+?)_)/g;
    let lastIndex = 0;
    let match;

    while ((match = inlineRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ text: text.substring(lastIndex, match.index), bold: false, italic: false });
      }
      if (match[1] !== undefined) {
        const inner = match[2];
        if (inner && inner.length > 0) segments.push({ text: inner, bold: true,  italic: false });
      } else if (match[3] !== undefined) {
        const inner = match[4];
        if (inner && inner.length > 0) segments.push({ text: inner, bold: false, italic: true  });
      } else if (match[5] !== undefined) {
        const inner = match[6];
        if (inner && inner.length > 0) segments.push({ text: inner, bold: false, italic: true  });
      }
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      segments.push({ text: text.substring(lastIndex), bold: false, italic: false });
    }
    if (segments.length === 0) segments.push({ text, bold: false, italic: false });

    return segments;
  }
}

// ============================================================
// FileManager クラス（v4.0 から無変更）
// ============================================================

/**
 * @class FileManager
 * @description Google Driveのファイル・フォルダ操作を担当するクラス。
 */
class FileManager {

  /** @param {string} rootFolderName */
  constructor(rootFolderName) {
    this._rootFolderName = rootFolderName;
    this._rootFolder     = null;
  }

  /**
   * ルートフォルダを取得する（初回のみ検索、以降はキャッシュ）。
   *
   * @returns {GoogleAppsScript.Drive.Folder}
   * @throws {Error}
   */
  getRootFolder() {
    if (this._rootFolder) return this._rootFolder;

    const iter = DriveApp.getFoldersByName(this._rootFolderName);
    if (!iter.hasNext()) {
      throw new Error(
        `[FileManager] ルートフォルダ "${this._rootFolderName}" が見つかりません。\n` +
        `CONFIG.ROOT_FOLDER_NAME と実際のフォルダ名が完全に一致しているか確認してください。\n` +
        `（全角/半角スペース・括弧の種類・末尾の空白に注意）`
      );
    }
    this._rootFolder = iter.next();
    Logger.log(`  ルートフォルダ確認: "${this._rootFolder.getName()}"`);
    return this._rootFolder;
  }

  /**
   * スラッシュ区切りのパスを辿り対象Googleドキュメントを返す。
   *
   * @param {string} filePath "フォルダ/.../ファイル名"
   * @returns {GoogleAppsScript.Document.Document}
   * @throws {Error}
   */
  getTargetDoc(filePath) {
    const parts = filePath.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error('[FileManager] ファイルパスが空です。');

    let folder      = this.getRootFolder();
    let currentPath = this._rootFolderName;

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += `/${parts[i]}`;
      folder = this._resolveSubfolder(folder, parts[i], currentPath);
    }

    return this._resolveDoc(folder, parts[parts.length - 1], filePath);
  }

  /** @private */
  _resolveSubfolder(parent, name, fullPath) {
    const iter = parent.getFoldersByName(name);
    if (!iter.hasNext()) {
      throw new Error(
        `[FileManager] フォルダ "${name}" が見つかりません。\n` +
        `  探索パス: ${fullPath} / 親: "${parent.getName()}"`
      );
    }
    return iter.next();
  }

  /** @private */
  _resolveDoc(folder, name, fullPath) {
    const iter = folder.getFilesByName(name);
    if (!iter.hasNext()) {
      const existing = [];
      const all = folder.getFiles();
      while (all.hasNext()) existing.push(`"${all.next().getName()}"`);
      throw new Error(
        `[FileManager] ファイル "${name}" が見つかりません。\n` +
        `  探索パス: ${fullPath}\n` +
        `  フォルダ内ファイル: ${existing.length > 0 ? existing.join(', ') : '（なし）'}`
      );
    }
    return DocumentApp.openById(iter.next().getId());
  }
}

// ============================================================
// DocEditor クラス（applyBlock の戻り値のみ v4.1 で変更）
// ============================================================

/**
 * @class DocEditor
 * @description Googleドキュメントへの書き込み・書式適用を担当するクラス。
 */
class DocEditor {

  /**
   * @param {GoogleAppsScript.Document.Document} doc
   * @param {Parser} parser
   */
  constructor(doc, parser) {
    this._doc    = doc;
    this._body   = doc.getBody();
    this._parser = parser;
  }

  // ----------------------------------------------------------
  // 公開メソッド
  // ----------------------------------------------------------

  /**
   * ブロックのメタデータと内容に基づいてドキュメントを更新する。
   *
   * [v4.1 変更点]
   * 戻り値に { isFound, success } オブジェクトを追加した。
   *   - isFound : 指定セクションがドキュメント内に存在したか
   *   - success : 処理が成功したか（このメソッドから例外が投げられると false 扱い）
   *
   * @param {{targetSection:string, action:string, content:string}} block
   * @returns {{ isFound: boolean, success: boolean }}
   */
  applyBlock(block) {
    const tokens      = this._parser.tokenize(block.content);
    const sectionInfo = this._findSection(block.targetSection);
    const isFound     = sectionInfo !== null; // ① セクションの有無を記録

    switch (block.action) {
      case 'REPLACE':
      case 'INTEGRATE':
        if (isFound) {
          Logger.log(
            `  → REPLACE: "${sectionInfo.matchedText}" を上書き` +
            (sectionInfo.matchType !== 'exact' ? ` (${sectionInfo.matchType})` : '')
          );
          this._replaceSection(sectionInfo, tokens);
        } else {
          Logger.log(
            `  ⚠️ [REPLACE] セクション "${block.targetSection}" が見つかりません → 末尾に新規追加`
          );
          this._appendTokens(tokens, false);
        }
        break;

      case 'APPEND':
      case 'CONDITION':
        if (isFound) {
          Logger.log(
            `  → APPEND: "${sectionInfo.matchedText}" の末尾に追記` +
            (sectionInfo.matchType !== 'exact' ? ` (${sectionInfo.matchType})` : '')
          );
          this._appendToSection(sectionInfo, tokens);
        } else {
          Logger.log(
            `  ⚠️ [APPEND] セクション "${block.targetSection}" が見つかりません → 末尾に新規追加`
          );
          this._appendTokens(tokens, false);
        }
        break;

      default:
        Logger.log(`  ⚠️ 未知のアクション "${block.action}" → APPEND として処理`);
        if (isFound) this._appendToSection(sectionInfo, tokens);
        else         this._appendTokens(tokens, false);
    }

    return { isFound, success: true }; // ① 正常終了時は success: true を返す
  }

  // ----------------------------------------------------------
  // セクション検索（超・強力正規化 + あいまい一致）
  // ----------------------------------------------------------

  /**
   * ドキュメント内から指定した見出し名のセクション情報を探す。
   *
   * マッチ優先順:
   *   1. exact   - 正規化後に完全一致
   *   2. prefix  - 正規化後に前方一致
   *   3. partial - 正規化後に部分一致
   *
   * 完全一致・前方一致・部分一致すべてに失敗した場合、デバッグ情報をログに出力する。
   *
   * @private
   * @param {string} sectionName
   * @returns {{headingIndex:number, level:number, endIndex:number,
   *            matchedText:string, matchType:string}|null}
   */
  _findSection(sectionName) {
    const body         = this._body;
    const count        = body.getNumChildren();
    const normalizedQ  = DocEditor._normalizeText(sectionName);

    let exactResult    = null;
    let prefixResult   = null;
    let partialResult  = null;
    let lastNormalizedH = '（見出しなし）';

    for (let i = 0; i < count; i++) {
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;

      const para    = child.asParagraph();
      const heading = para.getHeading();
      if (heading === DocumentApp.ParagraphHeading.NORMAL) continue;

      const rawText     = para.getText().trim();
      const normalizedH = DocEditor._normalizeText(rawText);
      const level       = this._headingToLevel(heading);
      lastNormalizedH   = normalizedH;

      if (normalizedH === normalizedQ) {
        exactResult = {
          headingIndex: i, level,
          endIndex    : this._findSectionEnd(i + 1, level),
          matchedText : rawText, matchType: 'exact',
        };
        break;
      }
      if (!prefixResult && normalizedH.startsWith(normalizedQ)) {
        prefixResult = {
          headingIndex: i, level,
          endIndex    : this._findSectionEnd(i + 1, level),
          matchedText : rawText, matchType: 'prefix',
        };
      }
      if (!partialResult && normalizedH.includes(normalizedQ)) {
        partialResult = {
          headingIndex: i, level,
          endIndex    : this._findSectionEnd(i + 1, level),
          matchedText : rawText, matchType: 'partial',
        };
      }
    }

    const result = exactResult || prefixResult || partialResult;

    if (!result) {
      Logger.log(
        `  ⚠️ セクション未発見のデバッグ情報:\n` +
        `     探した正規化文字列  : "${normalizedQ}"\n` +
        `     最後に確認した見出し: "${lastNormalizedH}"\n` +
        `     → 上記2つを比較して不一致の原因を特定してください。`
      );
    } else if (result.matchType !== 'exact') {
      Logger.log(
        `  ℹ️ 「${sectionName}」は完全一致なし。` +
        `${result.matchType === 'prefix' ? '前方一致' : '部分一致'}で` +
        `「${result.matchedText}」を使用します。`
      );
    }

    return result;
  }

  /**
   * テキストを正規化する（超・強力版）。v4.0 から無変更。
   *
   * 1. normalize('NFKC'): 全角英数字→半角、半角カタカナ→全角カタカナ
   * 2. 半角・全角カッコとその中身を除去
   * 3. コロン・ピリオド・句点を除去
   * 4. すべての空白を除去（半角・全角・タブ）
   * 5. toLowerCase()
   *
   * @private
   * @static
   * @param {string} text
   * @returns {string}
   */
  static _normalizeText(text) {
    return text
      .trim()
      .normalize('NFKC')
      .replace(/\([^)]*\)/g,             '')
      .replace(/（[^）]*）/g,            '')
      .replace(/[【〔「『][^】〕」』]*[】〕」』]/g, '')
      .replace(/[：:]/g,                 '')
      .replace(/[．。.]/g,               '')
      .replace(/[\s　\t]/g,              '')
      .toLowerCase();
  }

  /**
   * 指定インデックスから「同レベル以上の見出し」が現れる位置を返す。
   *
   * @private
   * @param {number} startIndex
   * @param {number} level
   * @returns {number}
   */
  _findSectionEnd(startIndex, level) {
    const body  = this._body;
    const count = body.getNumChildren();

    for (let i = startIndex; i < count; i++) {
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;

      const heading = child.asParagraph().getHeading();
      if (heading === DocumentApp.ParagraphHeading.NORMAL) continue;

      if (this._headingToLevel(heading) <= level) return i;
    }
    return count;
  }

  // ----------------------------------------------------------
  // セクション操作
  // ----------------------------------------------------------

  /** @private */
  _replaceSection(sectionInfo, tokens) {
    for (let i = sectionInfo.endIndex - 1; i > sectionInfo.headingIndex; i--) {
      this._body.getChild(i).removeFromParent();
    }
    this._insertTokensAt(sectionInfo.headingIndex + 1, tokens, true);
  }

  /** @private */
  _appendToSection(sectionInfo, tokens) {
    this._insertTokensAt(sectionInfo.endIndex, tokens, true);
  }

  /** @private */
  _appendTokens(tokens, skipFirstHeading) {
    let skip = skipFirstHeading;
    for (const token of tokens) {
      if (token.type === 'blank') continue;
      if (skip && token.type === 'heading') { skip = false; continue; }
      skip = false;
      this._appendToken(token);
    }
  }

  // ----------------------------------------------------------
  // トークン挿入（位置指定）
  // ----------------------------------------------------------

  /** @private */
  _insertTokensAt(insertAt, tokens, skipFirstHeading) {
    let idx  = insertAt;
    let skip = skipFirstHeading;

    for (const token of tokens) {
      if (token.type === 'blank') continue;
      if (skip && token.type === 'heading') { skip = false; continue; }
      skip = false;
      idx  = this._insertToken(token, idx);
    }
  }

  /** @private */
  _insertToken(token, idx) {
    const body = this._body;

    switch (token.type) {
      case 'heading': {
        const para = body.insertParagraph(idx, '');
        para.setHeading(this._levelToHeading(token.level));
        this._applyInlineStyles(para, token.text);
        return idx + 1;
      }
      case 'listItem': {
        const item = body.insertListItem(idx, '');
        item.setNestingLevel(token.nestingLevel);
        item.setGlyphType(
          token.ordered ? DocumentApp.GlyphType.NUMBER : DocumentApp.GlyphType.BULLET
        );
        this._applyInlineStyles(item, token.text);
        return idx + 1;
      }
      case 'table': {
        if (token.rows.length > 0) { body.insertTable(idx, token.rows); return idx + 1; }
        return idx;
      }
      case 'paragraph':
      default: {
        const para = body.insertParagraph(idx, '');
        para.setHeading(DocumentApp.ParagraphHeading.NORMAL);
        this._applyInlineStyles(para, token.text);
        return idx + 1;
      }
    }
  }

  // ----------------------------------------------------------
  // トークン追加（末尾）
  // ----------------------------------------------------------

  /** @private */
  _appendToken(token) {
    const body = this._body;

    switch (token.type) {
      case 'heading': {
        const para = body.appendParagraph('');
        para.setHeading(this._levelToHeading(token.level));
        this._applyInlineStyles(para, token.text);
        break;
      }
      case 'listItem': {
        const item = body.appendListItem('');
        item.setNestingLevel(token.nestingLevel);
        item.setGlyphType(
          token.ordered ? DocumentApp.GlyphType.NUMBER : DocumentApp.GlyphType.BULLET
        );
        this._applyInlineStyles(item, token.text);
        break;
      }
      case 'table': {
        if (token.rows.length > 0) body.appendTable(token.rows);
        break;
      }
      case 'paragraph':
      default: {
        const para = body.appendParagraph('');
        this._applyInlineStyles(para, token.text);
        break;
      }
    }
  }

  // ----------------------------------------------------------
  // インラインスタイル適用
  // ----------------------------------------------------------

  /**
   * インラインMarkdown記法を解析してGoogleドキュメントの書式を適用する。
   *
   * @private
   * @param {GoogleAppsScript.Document.Paragraph|GoogleAppsScript.Document.ListItem} element
   * @param {string} text
   */
  _applyInlineStyles(element, text) {
    const segments = Parser.parseInlineStyles(text);
    const textEl   = element.editAsText();
    const fullText = segments.map((s) => s.text).join('');
    textEl.setText(fullText);

    let offset = 0;
    for (const seg of segments) {
      const len = seg.text.length;
      if (len === 0) continue;
      const startIdx = offset;
      const endIdx   = Math.min(offset + len - 1, fullText.length - 1);
      if (startIdx <= endIdx) {
        if (seg.bold)   textEl.setBold(startIdx, endIdx, true);
        if (seg.italic) textEl.setItalic(startIdx, endIdx, true);
      }
      offset += len;
    }
  }

  // ----------------------------------------------------------
  // ヘルパー
  // ----------------------------------------------------------

  /** @private */
  _headingToLevel(heading) {
    const PH  = DocumentApp.ParagraphHeading;
    const map = new Map([
      [PH.HEADING1, 1], [PH.HEADING2, 2], [PH.HEADING3, 3],
      [PH.HEADING4, 4], [PH.HEADING5, 5], [PH.HEADING6, 6],
    ]);
    return map.get(heading) ?? 999;
  }

  /** @private */
  _levelToHeading(level) {
    const PH  = DocumentApp.ParagraphHeading;
    const map = {
      1: PH.HEADING1, 2: PH.HEADING2, 3: PH.HEADING3,
      4: PH.HEADING4, 5: PH.HEADING5, 6: PH.HEADING6,
    };
    return map[level] ?? PH.NORMAL;
  }
}