'use strict';

const serviceList = document.getElementById('serviceList');
const categoryFilter = document.getElementById('categoryFilter');
const searchInput = document.getElementById('searchInput');
const favoriteOnly = document.getElementById('favoriteOnly');
const sortKey = document.getElementById('sortKey');
const sortDirection = document.getElementById('sortDirection');
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
const editSecretToggle = document.getElementById('editSecretToggle');
const editFieldList = document.getElementById('editFieldList');
const addFieldButton = document.getElementById('addFieldButton');
const addServiceButton = document.getElementById('addServiceButton');
const deleteServiceButton = document.getElementById('deleteServiceButton');
const categoryOptions = document.getElementById('categoryOptions');
const accountLabelOptions = document.getElementById('accountLabelOptions');
const editFields = {
  name: document.getElementById('editName'),
  category: document.getElementById('editCategory'),
  accountLabel: document.getElementById('editAccountLabel'),
  url: document.getElementById('editUrl'),
  memo: document.getElementById('editMemo'),
  favorite: document.getElementById('editFavorite'),
};

// 伏せ字は文字数を固定し、値の長さも画面に出さない
const SECRET_MASK = '••••••••••';
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

let editingId = null; // 編集中のサービスの id。新規追加中は ''、閉じているときは null
let showSecretsInEdit = false;
let draggingId = null;
let sortDescending = false;
const visibleSecrets = new Set(); // 表示中の伏せ項目（`${id}#${index}`）
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

// fields がない古い形式（loginId・password）は、2つの項目として扱う
function normalizeFields(raw) {
  if (!Array.isArray(raw.fields)) {
    return [
      { label: 'ログインID', value: toText(raw.loginId), secret: false },
      { label: 'パスワード', value: toText(raw.password), secret: true },
    ];
  }
  return raw.fields
    .filter((field) => field && typeof field === 'object')
    .map((field) => ({ label: toText(field.label).trim(), value: toText(field.value), secret: field.secret === true }));
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
    fields: normalizeFields(raw),
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
  const next = { ...rawData[index], ...changes };
  if ('fields' in changes) {
    // 古い形式のキーは fields に置き換える
    delete next.loginId;
    delete next.password;
    hideSecrets(service.id);
  }
  rawData[index] = next;
  Object.assign(service, normalizeService(next));
  changeVersion += 1;
}

function rawIndexOf(serviceId) {
  return rawData.findIndex((item) => normalizeService(item)?.id === serviceId);
}

function createServiceId() {
  let id;
  do {
    id = `service-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  } while (rawIndexOf(id) !== -1);
  return id;
}

function addService(values) {
  const raw = { id: createServiceId(), ...values };
  rawData.push(raw);
  const service = normalizeService(raw);
  allServices.push(service);
  changeVersion += 1;
  return service;
}

function removeService(service) {
  rawData.splice(rawIndexOf(service.id), 1);
  allServices.splice(allServices.indexOf(service), 1);
  hideSecrets(service.id);
  changeVersion += 1;
}

// fromId のサービスを refId の直前（placeAfter なら直後）へ移動する（画面の並びと services.js の並びの両方）
function moveService(fromId, refId, placeAfter) {
  const move = (list, indexOf) => {
    const [item] = list.splice(indexOf(fromId), 1);
    list.splice(indexOf(refId) + (placeAfter ? 1 : 0), 0, item);
  };
  move(rawData, rawIndexOf);
  move(allServices, (id) => allServices.findIndex((service) => service.id === id));
  changeVersion += 1;
}

// ---------- services.js の形式 ----------

function buildServicesScript(data) {
  return [
    '// SaaS 管理ポータルのサービス情報です。',
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

// 表示の並び順だけを変える（services.js の順番は変えない）。同じ値どうしは名前順
function isCustomOrder() {
  return sortKey.value === 'custom';
}

function sortServices(services) {
  if (isCustomOrder()) {
    return services;
  }
  const valueOf = sortKey.value === 'name' ? displayName : categoryOf;
  const sign = sortDescending ? -1 : 1;
  return [...services].sort(
    (a, b) =>
      sign * valueOf(a).localeCompare(valueOf(b), 'ja') || displayName(a).localeCompare(displayName(b), 'ja'),
  );
}

// 昇順・降順のボタンは、名前やカテゴリで並べるときだけ表示する
function updateSortDirection() {
  sortDirection.hidden = isCustomOrder();
  sortDirection.textContent = sortDescending ? '↓ 降順' : '↑ 昇順';
  sortDirection.setAttribute('aria-label', sortDescending ? '降順で並べています。昇順に切り替える' : '昇順で並べています。降順に切り替える');
}

function handleSortKeyChange() {
  sortDescending = false;
  updateSortDirection();
  renderServices();
}

function toggleSortDirection() {
  sortDescending = !sortDescending;
  updateSortDirection();
  renderServices();
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

function secretKey(serviceId, index) {
  return `${serviceId}#${index}`;
}

function hideSecrets(serviceId) {
  Array.from(visibleSecrets)
    .filter((key) => key.startsWith(`${serviceId}#`))
    .forEach((key) => visibleSecrets.delete(key));
}

function fieldLabel(field) {
  return field.label || '（項目名なし）';
}

function applySecretState(card, service) {
  card.querySelectorAll('[data-action="toggle-secret"]').forEach((button) => {
    const field = service.fields[button.dataset.index];
    const valueNode = button.closest('.data-value').querySelector('.secret-value');
    const isVisible = visibleSecrets.has(secretKey(service.id, button.dataset.index));

    valueNode.textContent = isVisible ? field.value || '（未設定）' : SECRET_MASK;
    valueNode.classList.toggle('masked', !isVisible);
    button.textContent = isVisible ? '隠す' : '表示';
    button.setAttribute('aria-pressed', String(isVisible));
    button.setAttribute('aria-label', `${fieldLabel(field)}を${isVisible ? '隠す' : '表示'}`);
  });
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

  // URL は任意（スマホのPINなど、サイトがないものもある）。空なら欄ごと出さない
  if (service.url) {
    let urlNode;
    if (service.safeUrl) {
      urlNode = createElement('a', 'service-link', service.url);
      urlNode.href = service.safeUrl;
      urlNode.target = '_blank';
      urlNode.rel = 'noopener noreferrer';
    } else {
      urlNode = createElement('span', 'invalid-url', service.url);
      urlNode.title = 'HTTP/HTTPS 以外のURLは開けません';
    }
    body.appendChild(createField('ログインURL', urlNode));
  }

  service.fields.forEach((field, index) => {
    const buttons = [createSmallButton('コピー', 'copy', { index })];
    if (field.secret) {
      buttons.unshift(createSmallButton('表示', 'toggle-secret', { index }));
    }
    const valueNode = field.secret
      ? createElement('span', 'secret-value')
      : createElement('span', '', field.value || '（未設定）');
    body.appendChild(createField(fieldLabel(field), valueNode, buttons));
  });

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
  } else if (service.url) {
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

  card.draggable = isCustomOrder(); // 名前順などで表示中はドラッグしない
  applySecretState(card, service);
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
  [searchInput, categoryFilter, sortKey, favoriteOnly, addServiceButton].forEach((control) => {
    control.disabled = true;
  });
}

function renderServices() {
  const filtered = sortServices(getFilteredServices());
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
  const dragHint = isCustomOrder() ? 'カードはドラッグで並べ替えできます。' : '';
  setStatus(`${countText}${skippedNote}${dragHint}`);
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

function toggleSecret(service, card, index) {
  const key = secretKey(service.id, index);
  if (visibleSecrets.has(key)) {
    visibleSecrets.delete(key);
  } else {
    visibleSecrets.add(key);
  }
  applySecretState(card, service);
}

// ---------- 並べ替え（ドラッグ＆ドロップ） ----------

// ドラッグ中はカードを実際に入れ替え、ほかのカードが押しのけられるように動かす。
// ドロップした時点の並びを保存し、キャンセルした場合は元の並びに戻す
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function cardIds() {
  return Array.from(serviceList.querySelectorAll('.service-card'), (card) => card.dataset.id);
}

// DOM を変更した後、各カードを元の位置から新しい位置へアニメーションさせる（FLIP）
function animateReorder(mutate) {
  const cards = Array.from(serviceList.querySelectorAll('.service-card'));
  const before = new Map(cards.map((card) => [card, card.getBoundingClientRect()]));
  mutate();
  if (prefersReducedMotion.matches) {
    return;
  }

  cards.forEach((card) => {
    const from = before.get(card);
    const to = card.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) {
      return;
    }
    card.style.transition = 'none';
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    card.getBoundingClientRect(); // 移動前の位置を描画に反映させる
    card.style.transition = 'transform 0.2s ease';
    card.style.transform = '';
    // 動いている途中のカードの上では入れ替えない（行ったり来たりを防ぐ）
    card.classList.add('moving');
    setTimeout(() => {
      card.classList.remove('moving');
      card.style.transition = '';
    }, 200);
  });
}

function handleDragStart(event) {
  const card = event.target.closest('.service-card');
  if (!card) {
    return;
  }
  draggingId = card.dataset.id;
  event.dataTransfer.effectAllowed = 'move';
  // ドラッグ中の画像が作られた後に、元の位置を「置き場所」の見た目にする
  setTimeout(() => card.classList.add('dragging'), 0);
}

function handleDragOver(event) {
  if (draggingId === null) {
    return;
  }
  event.preventDefault();

  const dragged = serviceList.querySelector('.service-card.dragging');
  const target = event.target.closest('.service-card');
  if (!dragged || !target || target === dragged || target.classList.contains('moving')) {
    return;
  }
  const cards = Array.from(serviceList.children);
  const isForward = cards.indexOf(dragged) < cards.indexOf(target);
  animateReorder(() => (isForward ? target.after(dragged) : target.before(dragged)));
}

async function handleDrop(event) {
  if (draggingId === null) {
    return;
  }
  event.preventDefault();

  const ids = cardIds();
  const index = ids.indexOf(draggingId);
  const before = sortServices(getFilteredServices()).map((service) => service.id);
  if (ids.join('\n') === before.join('\n')) {
    return; // 元の位置に戻しただけ
  }

  // 表示中の隣のカードを基準に移動する（絞り込み中でも、表示していないカードの順番は変えない）
  if (index < ids.length - 1) {
    moveService(draggingId, ids[index + 1], false);
  } else {
    moveService(draggingId, ids[index - 1], true);
  }
  notifySaveResult(await saveAfterChange(), '並び順を変更しました');
}

// データの並びで描き直す（キャンセルした場合は元の並びに戻る）
function handleDragEnd() {
  draggingId = null;
  renderServices();
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
    case 'toggle-secret':
      toggleSecret(service, card, button.dataset.index);
      break;
    case 'copy': {
      const field = service.fields[button.dataset.index];
      copyText(field.value, fieldLabel(field));
      break;
    }
    case 'edit':
      openEditDialog(service);
      break;
    default:
      break;
  }
}

// ---------- 編集ダイアログ ----------

const NEW_SERVICE = {
  name: '',
  category: '',
  accountLabel: '',
  url: '',
  memo: '',
  favorite: false,
  fields: [
    { label: 'ログインID', value: '', secret: false },
    { label: 'パスワード', value: '', secret: true },
  ],
};

function fillDatalist(datalist, values) {
  datalist.replaceChildren(...values.map((value) => new Option(value)));
}

function updateFieldValueType(row) {
  const isSecret = row.querySelector('.field-secret').checked;
  row.querySelector('.field-value').type = isSecret && !showSecretsInEdit ? 'password' : 'text';
}

function setEditSecretsVisible(isVisible) {
  showSecretsInEdit = isVisible;
  editSecretToggle.textContent = isVisible ? '伏せた値を隠す' : '伏せた値を表示';
  editSecretToggle.setAttribute('aria-pressed', String(isVisible));
  Array.from(editFieldList.children).forEach(updateFieldValueType);
}

// 1行＝「項目名・値・伏せる・削除」
function createFieldRow(field) {
  const row = createElement('div', 'field-row');

  const label = createElement('input', 'field-name');
  label.type = 'text';
  label.value = field.label;
  label.maxLength = 200;
  label.autocomplete = 'off';
  label.placeholder = '項目名（例：メールアドレス）';
  label.setAttribute('aria-label', '項目名');

  const value = createElement('input', 'field-value');
  value.value = field.value;
  value.maxLength = 2000;
  value.autocomplete = 'off';
  value.spellcheck = false;
  value.setAttribute('aria-label', '値');

  const secretLabel = createElement('label', 'secret-check');
  const secret = createElement('input', 'field-secret');
  secret.type = 'checkbox';
  secret.checked = field.secret;
  secretLabel.append(secret, '伏せる');

  const remove = createSmallButton('削除', 'remove-field');
  remove.setAttribute('aria-label', 'この項目を削除');

  row.append(label, value, secretLabel, remove);
  updateFieldValueType(row);
  return row;
}

function handleFieldListClick(event) {
  const button = event.target.closest('[data-action="remove-field"]');
  if (!button) {
    return;
  }
  const row = button.closest('.field-row');
  const label = row.querySelector('.field-name').value.trim();
  if (window.confirm(label ? `項目「${label}」を削除しますか？` : 'この項目を削除しますか？')) {
    row.remove();
  }
}

function handleFieldListChange(event) {
  if (event.target.classList.contains('field-secret')) {
    updateFieldValueType(event.target.closest('.field-row'));
  }
}

function addFieldRow() {
  const row = createFieldRow({ label: '', value: '', secret: false });
  editFieldList.appendChild(row);
  row.querySelector('.field-name').focus();
}

function showEditError(message, field) {
  editError.textContent = message;
  editForm.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

// service が null のときは新規追加
function openEditDialog(service) {
  const source = service || NEW_SERVICE;
  editingId = service ? service.id : '';
  editTitle.textContent = service ? `${describe(service)}を編集` : '新しいサービスを追加';
  deleteServiceButton.hidden = !service;

  ['name', 'category', 'accountLabel', 'url', 'memo'].forEach((key) => {
    editFields[key].value = source[key];
  });
  editFields.favorite.checked = source.favorite;
  editFieldList.replaceChildren(...source.fields.map(createFieldRow));

  fillDatalist(categoryOptions, uniqueSorted(allServices.map((item) => item.category)));
  fillDatalist(accountLabelOptions, uniqueSorted(allServices.map((item) => item.accountLabel)));
  setEditSecretsVisible(false);
  showEditError('');

  editDialog.showModal();
  editFields.name.focus();
}

// 閉じたらフォームに入力値を残さず、元のボタンにフォーカスを戻す
function finishEditing() {
  if (editingId === null) {
    return;
  }
  const closedId = editingId;
  editingId = null;
  editForm.reset();
  editFieldList.replaceChildren();
  setEditSecretsVisible(false);
  showEditError('');
  if (closedId) {
    focusEditButton(closedId);
  } else {
    addServiceButton.focus();
  }
}

function closeEditDialog() {
  if (editDialog.open) {
    editDialog.close();
  }
  finishEditing();
}

function readEditForm() {
  const fields = Array.from(editFieldList.children)
    .map((row) => ({
      label: row.querySelector('.field-name').value.trim(),
      value: row.querySelector('.field-value').value,
      secret: row.querySelector('.field-secret').checked,
    }))
    .filter((field) => field.label || field.value);

  return {
    name: editFields.name.value.trim(),
    category: editFields.category.value.trim(),
    accountLabel: editFields.accountLabel.value.trim(),
    url: editFields.url.value.trim(),
    fields,
    memo: editFields.memo.value,
    favorite: editFields.favorite.checked,
  };
}

// 入力に問題があればエラーを表示して false を返す
function validateEditForm(values) {
  if (!values.name) {
    showEditError('サービス名を入力してください。', editFields.name);
    return false;
  }
  if (values.url && !toSafeUrl(values.url)) {
    showEditError('ログインURLは空欄にするか、http:// または https:// で始まるURLを入力してください。', editFields.url);
    return false;
  }
  const unnamed = Array.from(editFieldList.querySelectorAll('.field-name')).find(
    (input) => !input.value.trim() && input.closest('.field-row').querySelector('.field-value').value,
  );
  if (unnamed) {
    showEditError('項目名を入力してください。', unnamed);
    return false;
  }
  return true;
}

async function handleEditSubmit(event) {
  event.preventDefault();

  const isNew = editingId === '';
  const service = isNew ? null : findServiceById(editingId);
  if (!isNew && !service) {
    closeEditDialog();
    return;
  }

  const values = readEditForm();
  if (!validateEditForm(values)) {
    return;
  }

  if (isNew) {
    // 閉じた後は、追加したサービスの編集ボタンにフォーカスを移す
    editingId = addService(values).id;
    populateCategoryOptions();
    renderServices();
    closeEditDialog();
    notifySaveResult(await saveAfterChange(), 'サービスを追加しました');
    return;
  }

  // 変更した項目だけを反映する
  const changes = {};
  Object.entries(values).forEach(([key, value]) => {
    if (JSON.stringify(value) !== JSON.stringify(service[key])) {
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

async function handleDeleteService() {
  const service = findServiceById(editingId);
  if (!service || !window.confirm(`「${describe(service)}」を削除しますか？`)) {
    return;
  }

  removeService(service);
  editingId = ''; // 閉じた後は「新規追加」にフォーカスを移す
  populateCategoryOptions();
  renderServices();
  closeEditDialog();
  notifySaveResult(await saveAfterChange(), 'サービスを削除しました');
}

// ---------- 初期化 ----------

function loadInitialData() {
  const data = window.SERVICES;
  if (data === undefined) {
    showLoadError(
      'services.js を読み込めませんでした',
      'index.html と同じフォルダに services.js があるか、書式（カンマや引用符の過不足など）が正しいかを確認してください。初めて使う場合は、services.sample.js をコピーして services.js という名前で保存してください。',
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
  sortKey.addEventListener('change', handleSortKeyChange);
  sortDirection.addEventListener('click', toggleSortDirection);
  favoriteOnly.addEventListener('change', renderServices);
  serviceList.addEventListener('click', handleListClick);
  serviceList.addEventListener('dragstart', handleDragStart);
  serviceList.addEventListener('dragover', handleDragOver);
  serviceList.addEventListener('drop', handleDrop);
  serviceList.addEventListener('dragend', handleDragEnd);
  addServiceButton.addEventListener('click', () => openEditDialog(null));

  saveNowButton.addEventListener('click', handleSaveNow);
  chooseFileButton.addEventListener('click', handleChooseFile);
  downloadButton.addEventListener('click', downloadChanges);

  editForm.addEventListener('submit', handleEditSubmit);
  // Esc で閉じた場合
  editDialog.addEventListener('close', finishEditing);
  editDialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', closeEditDialog);
  });
  editSecretToggle.addEventListener('click', () => setEditSecretsVisible(!showSecretsInEdit));
  editFieldList.addEventListener('click', handleFieldListClick);
  editFieldList.addEventListener('change', handleFieldListChange);
  addFieldButton.addEventListener('click', addFieldRow);
  deleteServiceButton.addEventListener('click', handleDeleteService);

  window.addEventListener('beforeunload', (event) => {
    if (hasPendingChanges()) {
      event.preventDefault();
    }
  });
}

bindEvents();
loadInitialData();
