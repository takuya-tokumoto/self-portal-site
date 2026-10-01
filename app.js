'use strict';

const serviceList = document.getElementById('serviceList');
const categoryFilter = document.getElementById('categoryFilter');
const searchInput = document.getElementById('searchInput');
const favoriteOnly = document.getElementById('favoriteOnly');
const statusMessage = document.getElementById('statusMessage');
const toast = document.getElementById('toast');

const saveBar = document.getElementById('saveBar');
const saveBarMessage = document.getElementById('saveBarMessage');
const saveNowButton = document.getElementById('saveNowButton');
const chooseFileButton = document.getElementById('chooseFileButton');
const downloadButton = document.getElementById('downloadButton');

const editDialog = document.getElementById('editDialog');
const editForm = document.getElementById('editForm');
const editTitle = document.getElementById('editTitle');
const editError = document.getElementById('editError');
const editPasswordToggle = document.getElementById('editPasswordToggle');
const categoryOptions = document.getElementById('categoryOptions');
const accountLabelOptions = document.getElementById('accountLabelOptions');
const editFields = {
  name: document.getElementById('editName'),
  category: document.getElementById('editCategory'),
  accountLabel: document.getElementById('editAccountLabel'),
  url: document.getElementById('editUrl'),
  loginId: document.getElementById('editLoginId'),
  password: document.getElementById('editPassword'),
  memo: document.getElementById('editMemo'),
  favorite: document.getElementById('editFavorite'),
};

// 伏せ字は文字数を固定し、パスワードの長さも画面に出さない
const PASSWORD_MASK = '••••••••••';
const UNCATEGORIZED = '未分類';
const DATA_FILE_NAME = 'services.js';

// Edge・Chrome では File System Access API で services.js に直接保存できる
const supportsFilePicker = typeof window.showOpenFilePicker === 'function';

// 保存先のファイルハンドルだけを IndexedDB に記憶する（ID・パスワードなどの中身は保存しない）
const HANDLE_DB = 'saas-portal-mock';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = DATA_FILE_NAME;

// 認証情報はメモリ上と services.js だけで扱い、localStorage・ログ・URLには保存しない
const allServices = [];
let skippedCount = 0;
let rawData = []; // services.js の配列そのもの（画面で扱わない項目も保持する）
let fileSnapshot = ''; // services.js に保存されているはずの内容（ほかでの変更の検出に使う）
let changeVersion = 0;
let savedVersion = 0;
let fileHandle = null;
let saveProblem = null; // 保存できなかった理由
let autoSave = true; // 問題が起きたら、案内のボタンを押すまで自動保存しない
let saveQueue = Promise.resolve();

let editingId = null;
const visiblePasswordIds = new Set();
let toastTimer = null;

// ---------- 共通 ----------

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, isError ? 4000 : 2500);
}

function setStatus(message, type = '') {
  statusMessage.textContent = message;
  statusMessage.className = type ? `status-message ${type}` : 'status-message';
}

// 全角・半角や大文字・小文字の違いを吸収して比較する
function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

// HTTP/HTTPS のURLだけを許可する。それ以外は空文字を返す
function toSafeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

// ---------- データ ----------

function toText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function normalizeService(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const id = toText(raw.id).trim();
  if (!id) {
    return null;
  }

  const url = toText(raw.url).trim();
  return {
    id,
    name: toText(raw.name).trim(),
    category: toText(raw.category).trim(),
    accountLabel: toText(raw.accountLabel).trim(),
    url,
    safeUrl: toSafeUrl(url),
    loginId: toText(raw.loginId),
    password: toText(raw.password),
    memo: toText(raw.memo),
    favorite: raw.favorite === true,
  };
}

function displayName(service) {
  return service.name || '（名称未設定）';
}

function categoryOf(service) {
  return service.category || UNCATEGORIZED;
}

function describe(service) {
  return service.accountLabel ? `${displayName(service)}（${service.accountLabel}）` : displayName(service);
}

function findServiceById(serviceId) {
  return allServices.find((service) => service.id === serviceId);
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ja'));
}

function hasPendingChanges() {
  return changeVersion !== savedVersion;
}

// 画面の変更を services.js の配列に反映する（変更した項目だけを上書きする）
function applyChange(service, changes) {
  const index = rawData.findIndex((item) => normalizeService(item)?.id === service.id);
  if (index === -1) {
    return;
  }
  rawData[index] = { ...rawData[index], ...changes };
  Object.assign(service, normalizeService(rawData[index]));
  changeVersion += 1;
}

// ---------- services.js の形式 ----------

function buildServicesScript(data) {
  return [
    '// SaaS 管理ポータル（モック）のサービス情報です。すべて架空のデータです。',
    '// 画面から保存すると、このファイルは上書きされます。',
    '// 手で編集するときは、[ ] の中を JSON の形式で書いてください。',
    `window.SERVICES = ${JSON.stringify(data, null, 2)};`,
    '',
  ].join('\n');
}

// services.js の [ ] の中を JSON として読む。読めない場合は null を返す
function parseServicesScript(text) {
  const start = text.indexOf('window.SERVICES');
  const open = start === -1 ? -1 : text.indexOf('[', start);
  const close = text.lastIndexOf(']');
  if (open === -1 || close < open) {
    return null;
  }

  try {
    const data = JSON.parse(text.slice(open, close + 1));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ---------- 保存先の記憶（IndexedDB） ----------

function withHandleStore(mode, action) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const transaction = db.transaction(HANDLE_STORE, mode);
        const storeRequest = action(transaction.objectStore(HANDLE_STORE));
        transaction.oncomplete = () => {
          db.close();
          resolve(storeRequest.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

async function loadRememberedHandle() {
  try {
    const handle = await withHandleStore('readonly', (store) => store.get(HANDLE_KEY));
    return handle?.kind === 'file' ? handle : null;
  } catch {
    return null;
  }
}

async function rememberHandle(handle) {
  try {
    await withHandleStore('readwrite', (store) => store.put(handle, HANDLE_KEY));
  } catch {
    // 記憶できなくても、このタブを閉じるまでは保存できる
  }
}

async function forgetHandle() {
  fileHandle = null;
  try {
    await withHandleStore('readwrite', (store) => store.delete(HANDLE_KEY));
  } catch {
    // 記憶していない場合は何もしない
  }
}

// ---------- 保存 ----------

class SaveProblem extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const SAVE_PROBLEMS = {
  'not-selected': {
    message: '変更はまだ保存されていません。「services.js に保存」を押し、index.html と同じフォルダにある services.js を選んでください。',
    save: 'services.js に保存',
    download: true,
  },
  'needs-click': {
    message: '保存先に services.js を設定しました。「services.js に保存」を押して、ファイルの編集を許可してください。',
    save: 'services.js に保存',
  },
  denied: {
    message: 'services.js への書き込みが許可されなかったため、変更はまだ保存されていません。',
    save: 'もう一度保存',
    download: true,
  },
  conflict: {
    message:
      '保存先の services.js が、画面を開いたときの内容と異なるため保存していません。画面を開いた後にファイルが変更されたか、別の場所の services.js が保存先になっています。ファイルの内容を画面に反映するには F5 キーで再読み込みしてください（画面での変更は失われます）。',
    choose: true,
    download: true,
  },
  'invalid-file': {
    message: '選んだファイルは、このポータルの services.js ではないか、[ ] の中が JSON の形式になっていません。',
    choose: true,
    download: true,
  },
  missing: {
    message: '記憶していた保存先の services.js が見つかりません。移動または削除された可能性があります。',
    choose: true,
    download: true,
  },
  'write-failed': {
    message: 'services.js を読み書きできませんでした。ほかのアプリで開いていないか確認してください。',
    save: 'もう一度保存',
    download: true,
  },
  unsupported: {
    message: 'このブラウザでは services.js に直接保存できません。「変更をダウンロード」で保存し、元の services.js と置き換えてください。',
    download: true,
  },
};

function updateSaveBar() {
  const problem = hasPendingChanges() && saveProblem ? SAVE_PROBLEMS[saveProblem] : null;
  saveBar.hidden = !problem;
  if (!problem) {
    return;
  }

  saveBarMessage.textContent = problem.message;
  saveNowButton.hidden = !problem.save;
  saveNowButton.textContent = problem.save || '';
  chooseFileButton.hidden = !problem.choose;
  downloadButton.hidden = !problem.download;
}

async function getSaveHandle() {
  if (fileHandle) {
    return { handle: fileHandle, picked: false };
  }

  const remembered = await loadRememberedHandle();
  if (remembered) {
    fileHandle = remembered;
    return { handle: remembered, picked: false };
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      id: 'saas-portal',
      multiple: false,
      types: [{ description: 'サービス情報（services.js）', accept: { 'text/javascript': ['.js'] } }],
    });
    return { handle, picked: true };
  } catch {
    // キャンセルされた場合や、組織のポリシーでピッカーが使えない場合
    throw new SaveProblem('not-selected');
  }
}

async function readFileData(handle) {
  let text;
  try {
    const file = await handle.getFile();
    text = await file.text();
  } catch (error) {
    throw new SaveProblem(error.name === 'NotFoundError' ? 'missing' : 'write-failed');
  }

  const data = parseServicesScript(text);
  if (!data) {
    throw new SaveProblem('invalid-file');
  }
  return data;
}

// 保存先の内容が、画面を開いたとき（または前回保存したとき）と同じか確認する
async function verifyFile(handle) {
  const data = await readFileData(handle);
  if (JSON.stringify(data) !== fileSnapshot) {
    throw new SaveProblem('conflict');
  }
}

async function ensureWritePermission(handle) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') {
    return;
  }

  let state;
  try {
    state = await handle.requestPermission(options);
  } catch {
    // ファイル選択の直後などは、もう一度ボタンを押してもらう必要がある
    throw new SaveProblem('needs-click');
  }
  if (state !== 'granted') {
    throw new SaveProblem('denied');
  }
}

async function writePendingChanges() {
  if (!supportsFilePicker) {
    throw new SaveProblem('unsupported');
  }

  const { handle, picked } = await getSaveHandle();
  if (picked) {
    // 別のファイルを選んでいないか、書き込む前に確認する
    await verifyFile(handle);
    fileHandle = handle;
    await rememberHandle(handle);
  }

  await ensureWritePermission(handle);
  await verifyFile(handle);

  const version = changeVersion;
  const snapshot = JSON.stringify(rawData);
  const text = buildServicesScript(rawData);
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch {
    throw new SaveProblem('write-failed');
  }

  fileSnapshot = snapshot;
  savedVersion = version;
}

// 未保存の変更を services.js に書き込む。保存できたら true を返す
function flushChanges() {
  const result = saveQueue.then(async () => {
    if (hasPendingChanges()) {
      try {
        await writePendingChanges();
        saveProblem = null;
        autoSave = true;
      } catch (error) {
        saveProblem = error instanceof SaveProblem ? error.code : 'write-failed';
        autoSave = false;
        if (saveProblem === 'missing' || saveProblem === 'invalid-file') {
          await forgetHandle();
        }
      }
    }
    updateSaveBar();
    return saveProblem === null;
  });
  saveQueue = result.catch(() => {});
  return result;
}

async function saveAfterChange() {
  if (!autoSave) {
    updateSaveBar();
    return false;
  }
  return flushChanges();
}

function notifySaveResult(saved, action) {
  if (saved) {
    showToast(`${action}（services.js に保存しました）`);
  } else {
    showToast(`${action}。まだ保存されていません（画面上部の案内をご確認ください）`, true);
  }
}

async function handleSaveNow() {
  if (await flushChanges()) {
    showToast('services.js に保存しました');
  }
}

async function handleChooseFile() {
  await forgetHandle();
  await handleSaveNow();
}

function downloadChanges() {
  const blob = new Blob([buildServicesScript(rawData)], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = DATA_FILE_NAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  savedVersion = changeVersion;
  updateSaveBar();
  showToast('services.js をダウンロードしました。元の services.js と置き換えてから、F5 キーで再読み込みしてください');
}

// ---------- 絞り込み ----------

function populateCategoryOptions() {
  const current = categoryFilter.value;
  const categories = uniqueSorted(allServices.map(categoryOf));

  categoryFilter.replaceChildren(new Option('すべて', 'all'));
  categories.forEach((category) => {
    categoryFilter.appendChild(new Option(category, category));
  });
  categoryFilter.value = categories.includes(current) ? current : 'all';
}

function getFilteredServices() {
  // 空白区切りの語句をすべて含むもの（AND検索）
  const terms = normalizeText(searchInput.value).split(/\s+/).filter(Boolean);
  const selectedCategory = categoryFilter.value;
  const favoritesOnly = favoriteOnly.checked;

  return allServices.filter((service) => {
    if (selectedCategory !== 'all' && categoryOf(service) !== selectedCategory) {
      return false;
    }
    if (favoritesOnly && !service.favorite) {
      return false;
    }
    if (!terms.length) {
      return true;
    }

    const haystack = normalizeText(
      [displayName(service), categoryOf(service), service.accountLabel, service.memo].join('\n'),
    );
    return terms.every((term) => haystack.includes(term));
  });
}

function hasActiveFilter() {
  return searchInput.value.trim() !== '' || categoryFilter.value !== 'all' || favoriteOnly.checked;
}

function resetFilters() {
  searchInput.value = '';
  categoryFilter.value = 'all';
  favoriteOnly.checked = false;
  renderServices();
  searchInput.focus();
}

// ---------- 描画 ----------

function createFavoriteButton(service) {
  const button = createElement('button', 'favorite-btn');
  button.type = 'button';
  button.dataset.action = 'toggle-favorite';
  updateFavoriteButton(button, service);
  return button;
}

function updateFavoriteButton(button, service) {
  button.textContent = service.favorite ? '★' : '☆';
  button.classList.toggle('active', service.favorite);
  button.setAttribute('aria-pressed', String(service.favorite));
  button.setAttribute(
    'aria-label',
    service.favorite ? `${describe(service)}をお気に入りから外す` : `${describe(service)}をお気に入りに追加`,
  );
  button.title = service.favorite ? 'お気に入りから外す' : 'お気に入りに追加';
}

function createSmallButton(label, action, extra = {}) {
  const button = createElement('button', 'inline-btn', label);
  button.type = 'button';
  button.dataset.action = action;
  Object.entries(extra).forEach(([key, value]) => {
    button.dataset[key] = value;
  });
  return button;
}

function createField(labelText, valueNode, buttons = []) {
  const field = createElement('div', 'data-field');
  field.appendChild(createElement('div', 'field-label', labelText));

  const box = createElement('div', 'data-value');
  valueNode.classList.add('value-text');
  box.appendChild(valueNode);

  if (buttons.length) {
    const group = createElement('div', 'button-group');
    buttons.forEach((button) => group.appendChild(button));
    box.appendChild(group);
  }

  field.appendChild(box);
  return field;
}

function applyPasswordState(card, service) {
  const valueNode = card.querySelector('.password-value');
  const button = card.querySelector('[data-action="toggle-password"]');
  const isVisible = visiblePasswordIds.has(service.id);

  valueNode.textContent = isVisible ? service.password : PASSWORD_MASK;
  valueNode.classList.toggle('masked', !isVisible);
  button.textContent = isVisible ? '隠す' : '表示';
  button.setAttribute('aria-pressed', String(isVisible));
  button.setAttribute('aria-label', isVisible ? 'パスワードを隠す' : 'パスワードを表示');
}

function createServiceCard(service) {
  const card = createElement('article', 'service-card');
  card.dataset.id = service.id;

  // ヘッダー：サービス名・カテゴリ・用途・お気に入り
  const header = createElement('div', 'service-card-header');
  const titleBlock = createElement('div', 'title-block');
  titleBlock.appendChild(createElement('h2', 'service-name', displayName(service)));

  const tags = createElement('div', 'tag-row');
  tags.appendChild(createElement('span', 'tag tag-category', categoryOf(service)));
  if (service.accountLabel) {
    tags.appendChild(createElement('span', 'tag tag-account', service.accountLabel));
  }
  titleBlock.appendChild(tags);

  header.appendChild(titleBlock);
  header.appendChild(createFavoriteButton(service));
  card.appendChild(header);

  // 本文
  const body = createElement('div', 'service-body');

  let urlNode;
  if (service.safeUrl) {
    urlNode = createElement('a', 'service-link', service.url);
    urlNode.href = service.safeUrl;
    urlNode.target = '_blank';
    urlNode.rel = 'noopener noreferrer';
  } else {
    urlNode = createElement('span', 'invalid-url', service.url || '（未設定）');
    urlNode.title = 'HTTP/HTTPS 以外のURLは開けません';
  }
  body.appendChild(createField('ログインURL', urlNode));

  body.appendChild(
    createField('ログインID', createElement('span', '', service.loginId || '（未設定）'), [
      createSmallButton('コピー', 'copy', { target: 'loginId' }),
    ]),
  );

  body.appendChild(
    createField('パスワード', createElement('span', 'password-value'), [
      createSmallButton('表示', 'toggle-password'),
      createSmallButton('コピー', 'copy', { target: 'password' }),
    ]),
  );

  body.appendChild(createField('メモ', createElement('span', 'memo-text', service.memo || '—')));
  card.appendChild(body);

  // フッター：サービスを開く・編集
  const footer = createElement('div', 'service-card-footer');
  if (service.safeUrl) {
    const openLink = createElement('a', 'open-btn', 'サービスを開く');
    openLink.href = service.safeUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.setAttribute('aria-label', `${describe(service)}を新しいタブで開く`);
    footer.appendChild(openLink);
  } else {
    const disabled = createElement('button', 'open-btn', 'URLが無効なため開けません');
    disabled.type = 'button';
    disabled.disabled = true;
    footer.appendChild(disabled);
  }

  const editButton = createElement('button', 'edit-btn', '編集');
  editButton.type = 'button';
  editButton.dataset.action = 'edit';
  editButton.setAttribute('aria-label', `${describe(service)}を編集`);
  footer.appendChild(editButton);
  card.appendChild(footer);

  applyPasswordState(card, service);
  return card;
}

function createMessageBox(title, text, withReset = false) {
  const box = createElement('div', 'empty-state');
  box.appendChild(createElement('h2', '', title));
  box.appendChild(createElement('p', '', text));

  if (withReset) {
    const button = createElement('button', 'reset-btn', '条件をリセット');
    button.type = 'button';
    button.dataset.action = 'reset-filters';
    box.appendChild(button);
  }
  return box;
}

function showLoadError(title, text) {
  serviceList.replaceChildren(createMessageBox(title, text));
  setStatus('サービス情報を読み込めませんでした。', 'error');
  [searchInput, categoryFilter, favoriteOnly].forEach((control) => {
    control.disabled = true;
  });
}

function renderServices() {
  const filtered = getFilteredServices();
  const skippedNote = skippedCount ? `（不正なデータ ${skippedCount} 件は表示していません）` : '';

  if (!allServices.length) {
    serviceList.replaceChildren(
      createMessageBox('サービスが登録されていません', 'services.js にサービスを追加してください。'),
    );
    setStatus(`表示できるサービスがありません。${skippedNote}`, 'empty');
    return;
  }

  if (!filtered.length) {
    serviceList.replaceChildren(
      createMessageBox('一致するサービスはありません', '検索語句や絞り込み条件を変えてお試しください。', true),
    );
    setStatus(`検索結果は 0 件です。${skippedNote}`, 'empty');
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((service) => fragment.appendChild(createServiceCard(service)));
  serviceList.replaceChildren(fragment);

  const countText = hasActiveFilter()
    ? `${allServices.length} 件中 ${filtered.length} 件を表示しています。`
    : `${allServices.length} 件のサービスを表示しています。`;
  setStatus(`${countText}${skippedNote}`);
}

function focusEditButton(serviceId) {
  const card = serviceList.querySelector(`.service-card[data-id="${CSS.escape(serviceId)}"]`);
  const button = card && card.querySelector('[data-action="edit"]');
  if (button) {
    button.focus();
  }
}

// ---------- カードの操作 ----------

async function copyText(text, label) {
  if (!text) {
    showToast(`${label}が設定されていません`, true);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}をコピーしました`);
  } catch {
    showToast(`${label}をコピーできませんでした`, true);
  }
}

async function toggleFavorite(service, button) {
  applyChange(service, { favorite: !service.favorite });

  if (favoriteOnly.checked && !service.favorite) {
    // お気に入りのみ表示中に外した場合は一覧から消す
    renderServices();
  } else {
    updateFavoriteButton(button, service);
  }

  const action = service.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました';
  notifySaveResult(await saveAfterChange(), action);
}

function togglePassword(service, card) {
  if (visiblePasswordIds.has(service.id)) {
    visiblePasswordIds.delete(service.id);
  } else {
    visiblePasswordIds.add(service.id);
  }
  applyPasswordState(card, service);
}

function handleListClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || !serviceList.contains(button)) {
    return;
  }

  if (button.dataset.action === 'reset-filters') {
    resetFilters();
    return;
  }

  const card = button.closest('.service-card');
  const service = card && findServiceById(card.dataset.id);
  if (!service) {
    return;
  }

  switch (button.dataset.action) {
    case 'toggle-favorite':
      toggleFavorite(service, button);
      break;
    case 'toggle-password':
      togglePassword(service, card);
      break;
    case 'copy':
      if (button.dataset.target === 'loginId') {
        copyText(service.loginId, 'ログインID');
      } else {
        copyText(service.password, 'パスワード');
      }
      break;
    case 'edit':
      openEditDialog(service);
      break;
    default:
      break;
  }
}

// ---------- 編集ダイアログ ----------

function fillDatalist(datalist, values) {
  datalist.replaceChildren(...values.map((value) => new Option(value)));
}

function setEditPasswordVisible(isVisible) {
  editFields.password.type = isVisible ? 'text' : 'password';
  editPasswordToggle.textContent = isVisible ? '隠す' : '表示';
  editPasswordToggle.setAttribute('aria-pressed', String(isVisible));
  editPasswordToggle.setAttribute('aria-label', isVisible ? 'パスワードを隠す' : 'パスワードを表示');
}

function showEditError(message, field) {
  editError.textContent = message;
  Object.values(editFields).forEach((input) => input.removeAttribute('aria-invalid'));
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function openEditDialog(service) {
  editingId = service.id;
  editTitle.textContent = `${describe(service)}を編集`;

  ['name', 'category', 'accountLabel', 'url', 'loginId', 'password', 'memo'].forEach((key) => {
    editFields[key].value = service[key];
  });
  editFields.favorite.checked = service.favorite;

  fillDatalist(categoryOptions, uniqueSorted(allServices.map((item) => item.category)));
  fillDatalist(accountLabelOptions, uniqueSorted(allServices.map((item) => item.accountLabel)));
  setEditPasswordVisible(false);
  showEditError('');

  editDialog.showModal();
  editFields.name.focus();
}

// 閉じたらフォームに入力値を残さず、編集ボタンにフォーカスを戻す
function finishEditing() {
  if (editingId === null) {
    return;
  }
  const closedId = editingId;
  editingId = null;
  editForm.reset();
  setEditPasswordVisible(false);
  showEditError('');
  focusEditButton(closedId);
}

function closeEditDialog() {
  if (editDialog.open) {
    editDialog.close();
  }
  finishEditing();
}

function readEditForm() {
  return {
    name: editFields.name.value.trim(),
    category: editFields.category.value.trim(),
    accountLabel: editFields.accountLabel.value.trim(),
    url: editFields.url.value.trim(),
    loginId: editFields.loginId.value,
    password: editFields.password.value,
    memo: editFields.memo.value,
    favorite: editFields.favorite.checked,
  };
}

async function handleEditSubmit(event) {
  event.preventDefault();

  const service = findServiceById(editingId);
  if (!service) {
    closeEditDialog();
    return;
  }

  const values = readEditForm();
  if (!values.name) {
    showEditError('サービス名を入力してください。', editFields.name);
    return;
  }
  if (!toSafeUrl(values.url)) {
    showEditError('ログインURLは http:// または https:// で始まるURLを入力してください。', editFields.url);
    return;
  }

  // 変更した項目だけを反映する
  const changes = {};
  Object.entries(values).forEach(([key, value]) => {
    if (value !== service[key]) {
      changes[key] = value;
    }
  });
  if (!Object.keys(changes).length) {
    closeEditDialog();
    showToast('変更はありません');
    return;
  }

  applyChange(service, changes);
  populateCategoryOptions();
  renderServices();
  closeEditDialog();
  notifySaveResult(await saveAfterChange(), '変更を反映しました');
}

// ---------- 初期化 ----------

function loadInitialData() {
  const data = window.SERVICES;
  if (data === undefined) {
    showLoadError(
      'services.js を読み込めませんでした',
      'index.html と同じフォルダに services.js があるか、書式（カンマや引用符の過不足など）が正しいかを確認してください。',
    );
    return;
  }
  if (!Array.isArray(data)) {
    showLoadError('services.js の形式が正しくありません', 'window.SERVICES = [ ... ]; の [ ] の中にサービス情報を書いてください。');
    return;
  }

  rawData = data;
  fileSnapshot = JSON.stringify(data);

  const seenIds = new Set();
  data.forEach((raw) => {
    const service = normalizeService(raw);
    if (!service || seenIds.has(service.id)) {
      skippedCount += 1;
      return;
    }
    seenIds.add(service.id);
    allServices.push(service);
  });

  populateCategoryOptions();
  renderServices();
}

function bindEvents() {
  searchInput.addEventListener('input', renderServices);
  categoryFilter.addEventListener('change', renderServices);
  favoriteOnly.addEventListener('change', renderServices);
  serviceList.addEventListener('click', handleListClick);

  saveNowButton.addEventListener('click', handleSaveNow);
  chooseFileButton.addEventListener('click', handleChooseFile);
  downloadButton.addEventListener('click', downloadChanges);

  editForm.addEventListener('submit', handleEditSubmit);
  // Esc で閉じた場合
  editDialog.addEventListener('close', finishEditing);
  editDialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', closeEditDialog);
  });
  editPasswordToggle.addEventListener('click', () => {
    setEditPasswordVisible(editFields.password.type === 'password');
  });

  window.addEventListener('beforeunload', (event) => {
    if (hasPendingChanges()) {
      event.preventDefault();
    }
  });
}

bindEvents();
loadInitialData();
