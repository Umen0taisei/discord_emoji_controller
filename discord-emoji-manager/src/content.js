// Discord Emoji Manager — content script v4

(function () {
  'use strict';

  const S_CATS    = 'dem_categories';
  const S_ASSIGNS = 'dem_assignments';
  const S_ORDER   = 'dem_order';
  const S_POS     = 'dem_panel_pos';
  const S_TAGS      = 'dem_tags';
  const S_TEMPLATES = 'dem_templates';

  // 状態指定
  let state = {
    categories:   [],
    assignments:  {},   // emojiId -> categoryId
    emojiOrder:   [],   // id[]  カスタム並び順
    emojis:       [],   // { id, name, url, guildName, unicode }
    currentCat:   'all',
    selected:     new Set(),
    sortOrder:    'custom',
    search:       '',
    panelVisible: false,
    tags:         {},   // emojiId -> categoryId[]
    templates:    [],   // { id, name, emojis: (id | emoji)[] }[]
    activeTab:    'emoji',
    reactionMode: false,  // リアクションピッカーが開いているか
  };

  // ドラッグ中の状態（グローバル変数でシンプルに管理）
  let dragIds    = null;   // string[] | null
  // let dragTarget = null;   // 'grid' | 'cat' — どこに向かっているか
  let modalMode = 'category';
  let panelHome = null;
  let panelEl = null;
  let reactionPickerEl = null;

  // ── ストレージ ─────────────────────────────────────────────────────────
  function loadStorage() {
    return new Promise(resolve => {
      chrome.storage.local.get([S_CATS, S_ASSIGNS, S_ORDER, S_POS, S_TAGS, S_TEMPLATES], res => {
        if (res[S_CATS])      state.categories  = res[S_CATS];
        if (res[S_ASSIGNS])   state.assignments = res[S_ASSIGNS];
        if (res[S_ORDER])     state.emojiOrder  = res[S_ORDER];
        if (res[S_TAGS])      state.tags        = res[S_TAGS];
        if (res[S_TEMPLATES]) state.templates   = res[S_TEMPLATES];
        migrateAssignmentsToMemberships();
        resolve(res[S_POS] || null);
      });
    });
  }
  const saveCats    = () => chrome.storage.local.set({ [S_CATS]:    state.categories  });
  const saveAssigns = () => chrome.storage.local.set({ [S_ASSIGNS]: state.assignments });
  const saveOrder   = () => chrome.storage.local.set({ [S_ORDER]:   state.emojiOrder  });
  const savePos     = (x,y) => chrome.storage.local.set({ [S_POS]: {x,y} });
  const saveTags      = () => chrome.storage.local.set({ [S_TAGS]:      state.tags      });
  const saveTemplates = () => chrome.storage.local.set({ [S_TEMPLATES]: state.templates });

  function migrateAssignmentsToMemberships() {
    let changed = false;
    Object.entries(state.assignments).forEach(([emojiId, catId]) => {
      if (!catId) return;
      if (!state.tags[emojiId]) state.tags[emojiId] = [];
      if (!state.tags[emojiId].includes(catId)) {
        state.tags[emojiId].push(catId);
        changed = true;
      }
    });
    if (changed) saveTags();
    if (Object.keys(state.assignments).length > 0) {
      state.assignments = {};
      saveAssigns();
    }
  }

  function getCategoryIds(emojiId) {
    return state.tags[emojiId] || [];
  }

  function addCategory(emojiId, catId) {
    if (!state.tags[emojiId]) state.tags[emojiId] = [];
    if (!state.tags[emojiId].includes(catId)) state.tags[emojiId].push(catId);
  }

  function clearCategories(emojiId) {
    delete state.tags[emojiId];
    delete state.assignments[emojiId];
  }

  // ── Unicode絵文字一覧 ───────────────────────────────────────────────────
  const UNICODE_REACTION_NAMES = {
    smiling_hearts: 'smiling_face_with_3_hearts',
    rofl: 'rolling_on_the_floor_laughing',
    nauseated: 'nauseated_face',
    partying: 'partying_face',
    thumbsup: 'thumbs_up',
    thumbsdown: 'thumbs_down',
    moon: 'crescent_moon',
    hand_left: 'point_left',
    hand_up: 'point_up_2',
    hand_right: 'point_right',
    hand_down: 'point_down',
    kiss: 'kissing_heart',
  };

  const UNICODE_EMOJIS = [
    ['😀','grinning'],['😂','joy'],['🤣','rofl'],['😊','blush'],['😍','heart_eyes'],
    ['🥰','smiling_hearts'],['😎','sunglasses'],['🤔','thinking'],['😭','sob'],
    ['😅','sweat_smile'],['🥺','pleading'],['😤','triumph'],['🤯','exploding_head'],
    ['😴','sleeping'],['🤢','nauseated'],['😇','innocent'],['🥳','partying'],
    ['😈','smiling_imp'],['💀','skull'],['👻','ghost'],['🤡','clown'],
    ['👍','thumbsup'],['👎','thumbsdown'],['👏','clap'],['🙏','pray'],
    ['💪','muscle'],['🫡','saluting'],['🤌','pinched_fingers'],['🤝','handshake'],
    ['🙌','raised_hands'],['👀','eyes'],['✨','sparkles'],['🔥','fire'],
    ['💯','100'],['❤️','heart'],['💔','broken_heart'],['💕','two_hearts'],
    ['⭐','star'],['🎉','tada'],['🎮','video_game'],['🏆','trophy'],
    ['⚡','zap'],['🌙','moon'],['☀️','sunny'],['🌈','rainbow'],
    ['🐱','cat'],['🐶','dog'],['🦊','fox'],['🐸','frog'],['🐧','penguin'],
    ['🍕','pizza'],['🍣','sushi'],['☕','coffee'],['🧋','bubble_tea'],['🍜','ramen'],
    ['👈','hand_left'],['👆','hand_up'],['👉','hand_right'],['👇','hand_down'],
    ['😘','kiss'],
  ].map(([ch, name]) => {
    const reactionName = UNICODE_REACTION_NAMES[name] || name;
    return {
      id: 'u_' + name,
      name,
      url: ch,
      guildName: 'Unicode',
      unicode: true,
      reactionName,
      aliases: reactionName === name ? [] : [reactionName],
    };
  });

  // ── 絵文字収集 ─────────────────────────────────────────────────────────
  function collectCustomFromDOM() {
    const imgs = document.querySelectorAll(
      '[class*="emojiItem"] img, [class*="emoji-item"] img, [data-type="emoji"] img'
    );
    const result = [], seen = new Set();
    imgs.forEach(img => {
      const src = img.src || '';
      const m   = src.match(/emojis\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      const name      = (img.alt || img.getAttribute('aria-label') || id).replace(/:/g,'');
      const guildEl   = img.closest('[class*="categorySection"]');
      const guildName = guildEl?.querySelector('[class*="categoryName"]')?.textContent?.trim() || 'カスタム';
      result.push({ id, name, url: src, guildName, unicode: false });
    });
    return result;
  }

  function mergeEmojis(list) {
    const existing = new Set(state.emojis.map(e => e.id));
    let added = false;
    list.forEach(e => {
      if (existing.has(e.id)) return;
      state.emojis.push(e);
      existing.add(e.id);
      if (!state.emojiOrder.includes(e.id)) state.emojiOrder.push(e.id);
      added = true;
    });
    return added;
  }

  function watchEmojiPicker() {
    let reactionPickerOpen = false;
  
    new MutationObserver(() => {
      const picker = findEmojiPicker();
  
      const isReaction = Boolean(picker && isReactionPicker(picker));
  
      if (picker && isReaction !== reactionPickerOpen) {
        reactionPickerOpen = isReaction;
        state.reactionMode = isReaction;
        updateReactionModeUI();
      }
  
      if (!picker && reactionPickerOpen) {
        reactionPickerOpen = false;
        state.reactionMode = false;
        updateReactionModeUI();
      }
  
      // カスタム絵文字の収集
      if (picker) {
        setTimeout(() => {
          if (mergeEmojis(collectCustomFromDOM())) {
            saveOrder();
            if (state.panelVisible) renderGrid();
          }
        }, 400);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function findEmojiPicker() {
    const selectors = [
      '[class*="emojiPicker"]',
      '[class*="emojiPickerHasTabWrapper"]',
      '[class*="emojiPickerInExpressionPicker"]',
      '[class*="contentWrapper"]',
      '[role="dialog"]',
      '[aria-label*="絵文字"]',
      '[aria-label*="リアクション"]',
      '[aria-label*="emoji" i]',
      '[aria-label*="reaction" i]',
    ];
    return Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(el => !el.closest('#dem-panel') && isVisible(el))
      .find(isEmojiPickerElement)
      || null;
  }

  function isEmojiPickerElement(el) {
    const className = typeof el.className === 'string' ? el.className : '';
    const label = el.getAttribute('aria-label') || '';
    const marker = `${className} ${label}`.toLowerCase();
    const hasPickerLabel = marker.includes('emoji')
      || marker.includes('絵文字')
      || marker.includes('reaction')
      || marker.includes('リアクション');
    const hasEmojiItem = Boolean(el.querySelector('[class*="emojiItem"] img, [class*="emoji-item"] img, [data-type="emoji"] img'));
    return (hasPickerLabel || hasEmojiItem) && (findReactionSearchInput(el) || hasEmojiItem);
  }

  function isReactionPicker(picker) {
    if (
      document.querySelector('[class*="reactionPicker"]') ||
      document.querySelector('[class*="reaction"][class*="picker"]') ||
      picker.closest('[class*="reaction"]')
    ) return true;

    const searchInput = findReactionSearchInput(picker);
    if (!searchInput) return false;
    if (isReactionSearchInput(searchInput)) return true;

    const composer = findComposerInput();
    if (!composer) return true;

    const pickerRect = picker.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const farFromComposer = Math.abs(pickerRect.bottom - composerRect.top) > 160;
    const aboveComposer = pickerRect.bottom < composerRect.top - 24;
    return farFromComposer || aboveComposer;
  }

  function isReactionSearchInput(input) {
    const text = [
      input.placeholder,
      input.getAttribute('aria-label'),
      input.getAttribute('name'),
    ].filter(Boolean).join(' ').toLowerCase();
    return text.includes('reaction') || text.includes('リアクション');
  }

  function findComposerInput() {
    return document.querySelector('[data-slate-editor="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('div[contenteditable="true"]');
  }

  function findReactionSearchInput(root = document) {
    const searchSelectors = [
      'input[type="text"]',
      'input[placeholder]',
      '[class*="search"] input',
    ];
    for (const sel of searchSelectors) {
      const input = root.querySelector(sel);
      if (input && isVisible(input)) return input;
    }
    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  
  function updateReactionModeUI() {
    const panel = getPanel();
    const header = panel?.querySelector('#dem-header-title');
    if (!header || !panel) return;
    if (state.reactionMode) {
      header.textContent = '⚡ リアクション検索モード';
      panel.classList.add('dem-reaction-mode');
      attachPanelToPicker();
      // パネルが閉じていたら自動で開く
      if (!state.panelVisible) togglePanel();
    } else {
      header.textContent = '😄 絵文字マネージャー';
      panel.classList.remove('dem-reaction-mode');
      restorePanelHome();
    }
  }

  function attachPanelToPicker() {
    const panel = getPanel();
    const picker = findEmojiPicker();
    if (!panel || !picker || picker.contains(panel)) return;
    if (reactionPickerEl && reactionPickerEl !== picker) {
      reactionPickerEl.classList.remove('dem-native-picker-muted');
    }
    picker.classList.add('dem-native-picker-muted');
    reactionPickerEl = picker;
    if (!panelHome) panelHome = panel.parentNode || document.body;
    picker.appendChild(panel);
  }

  function restorePanelHome() {
    const panel = getPanel();
    if (reactionPickerEl) {
      reactionPickerEl.classList.remove('dem-native-picker-muted');
      reactionPickerEl = null;
    }
    if (!panel || !panelHome || panel.parentNode === panelHome) return;
    panelHome.appendChild(panel);
  }

  function getPanel() {
    return panelEl || $('dem-panel');
  }

  // ── UI構築 ────────────────────────────────────────────────────────────
  function buildPanel() {
    const btn = el('button', { id: 'dem-toggle-btn', title: '絵文字マネージャー（ドラッグで移動）' });
    btn.textContent = '😄';
    document.body.appendChild(btn);
    makeDraggableBtn(btn);

    const panel = el('div', { id: 'dem-panel', className: 'dem-hidden' });
    panelEl = panel;
    panel.innerHTML = `
    <div id="dem-header">
      <span id="dem-header-title">⭐ 絵文字マネージャー</span>
      <button id="dem-close-btn">✕</button>
    </div>
    <div id="dem-tab-bar">
      <button class="dem-tab-btn dem-tab-active" id="dem-tab-emoji">絵文字</button>
      <button class="dem-tab-btn" id="dem-tab-tmpl">テンプレート</button>
    </div>
    <div id="dem-emoji-pane">
      <div id="dem-toolbar">
        <input id="dem-search" type="text" placeholder="絵文字を検索...">
        <button id="dem-sort-btn">↕ カスタム順</button>
      </div>
      <div id="dem-cats"></div>
      <div id="dem-info-bar" class="dem-hidden"></div>
      <div id="dem-grid"></div>
      <div id="dem-footer">
        <span id="dem-sel-info">クリックで挿入 / ドラッグで並び替え・所属追加</span>
        <button class="dem-footer-btn" id="dem-tag-btn">＋所属 ▾</button>        
        <button class="dem-footer-btn" id="dem-tmpl-save-btn">📋保存</button>
        <button class="dem-footer-btn dem-primary" id="dem-desel-btn">解除</button>
      </div>
      <div id="dem-tag-dropdown"></div>
    </div>
    <div id="dem-tmpl-pane" class="dem-hidden">
      <div id="dem-tmpl-list"></div>
    </div>
  `;    document.body.appendChild(panel);

    const modal = el('div', { id: 'dem-modal-bg' });
    modal.innerHTML = `
      <div id="dem-modal">
        <h3>新しいカテゴリ</h3>
        <input id="dem-modal-input" type="text" placeholder="例：推し、リアクション用">
        <div id="dem-modal-btns">
          <button class="dem-modal-btn cancel" id="dem-modal-cancel">キャンセル</button>
          <button class="dem-modal-btn ok" id="dem-modal-ok">作成</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    bindEvents();
    makeDraggable(panel);
  }

  function el(tag, props = {}) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    return e;
  }

  function bindEvents() {
    $('dem-close-btn').onclick    = togglePanel;
    $('dem-modal-cancel').onclick = closeModal;
    $('dem-modal-ok').onclick     = submitModal;
    $('dem-sort-btn').onclick     = cycleSort;
    $('dem-tag-btn').onclick      = toggleTagDropdown;
    $('dem-tmpl-save-btn').onclick = openTemplateModal;
    $('dem-desel-btn').onclick    = () => { state.selected.clear(); renderGrid(); updateFooter(); };
    $('dem-modal-input').onkeydown = e => { if (e.key === 'Enter') submitModal(); };
    $('dem-search').oninput    = e => { state.search    = e.target.value.toLowerCase(); renderGrid(); };

    $('dem-tab-emoji').onclick = () => switchTab('emoji');
    $('dem-tab-tmpl').onclick  = () => switchTab('template');

    document.addEventListener('click', e => {
      const tdd = $('dem-tag-dropdown');
      if (tdd && !tdd.contains(e.target) && e.target !== $('dem-tag-btn'))  tdd.classList.remove('dem-visible');
    });
  }

  function switchTab(tab) {
    state.activeTab = tab;
    $('dem-tab-emoji').classList.toggle('dem-tab-active', tab === 'emoji');
    $('dem-tab-tmpl').classList.toggle('dem-tab-active',  tab === 'template');
    $('dem-emoji-pane').classList.toggle('dem-hidden', tab !== 'emoji');
    $('dem-tmpl-pane').classList.toggle('dem-hidden',  tab !== 'template');
    if (tab === 'template') renderTemplates();
  }

  function $(id) { return document.getElementById(id); }

  // ── パネルドラッグ ────────────────────────────────────────────────────
  function makeDraggable(panel) {
    let on = false, sx, sy, ox, oy;
    $('dem-header').addEventListener('mousedown', e => {
      on = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!on) return;
      panel.style.cssText += `left:${ox+e.clientX-sx}px;top:${oy+e.clientY-sy}px;right:auto;bottom:auto;`;
    });
    document.addEventListener('mouseup', () => {
      if (!on) return; on = false;
      document.body.style.userSelect = '';
      savePos(parseInt(panel.style.left), parseInt(panel.style.top));
    });
  }

  // ── トグルボタンのドラッグ移動 ──────────────────────────────────────
const S_BTN_POS = 'dem_btn_pos';

function saveBtnPos(y) { chrome.storage.local.set({ [S_BTN_POS]: { y } }); }

function makeDraggableBtn(btn) {
  let dragging = false, moved = false, sy, oy;

  btn.addEventListener('mousedown', e => {
    dragging = true; moved = false;
    sy = e.clientY;
    oy = btn.getBoundingClientRect().top;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dy = e.clientY - sy;
    if (Math.abs(dy) > 4) moved = true; // 少し動いたらドラッグとみなす
    if (!moved) return;
    // 上下のみ移動（右端固定）
    const newTop = Math.max(0, Math.min(window.innerHeight - 44, oy + dy));
    btn.style.top    = newTop + 'px';
    btn.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    if (moved) {
      saveBtnPos(parseInt(btn.style.top));
    } else {
      // ほとんど動いていない → クリックとして扱う
      togglePanel();
    }
  });

  // 保存済みの位置を復元
  chrome.storage.local.get([S_BTN_POS], res => {
    if (res[S_BTN_POS]) {
      btn.style.top    = res[S_BTN_POS].y + 'px';
      btn.style.bottom = 'auto';
    }
  });
}

  function applyPos(pos) {
    if (!pos) return;
    const p = $('dem-panel');
    p.style.left = pos.x+'px'; p.style.top = pos.y+'px';
    p.style.right = 'auto'; p.style.bottom = 'auto';
  }

  function togglePanel() {
    state.panelVisible = !state.panelVisible;
    const panel = $('dem-panel');
    panel.classList.toggle('dem-hidden', !state.panelVisible);
    if (state.panelVisible) {
      // 開くたびに右下の定位置にリセット（画面外に出るのを防ぐ）
      panel.style.right  = '8px';
      panel.style.bottom = '120px';
      panel.style.left   = 'auto';
      panel.style.top    = 'auto';
      renderAll();
    }
  }

  // ── レンダリング ──────────────────────────────────────────────────────
  function renderAll() { renderCats(); renderGrid(); updateFooter(); }

  function getCatName(catId) {
    if (!catId) return '未分類';
    const c = state.categories.find(c => c.id === catId);
    return c ? c.name : '未分類';
  }

  function getMembershipLabel(emojiId) {
    const names = getCategoryIds(emojiId).map(getCatName);
    if (names.length === 0) return '未分類';
    if (names.length === 1) return names[0];
    return `${names[0]} +${names.length - 1}`;
  }

  function getEmojiSearchText(emoji) {
    return [
      emoji.name,
      emoji.reactionName,
      emoji.guildName,
      ...(emoji.aliases || []),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function getReactionSearchName(emoji) {
    return emoji.reactionName || emoji.name;
  }

  function toggleTagDropdown() {
    const dd = $('dem-tag-dropdown');
    dd.classList.toggle('dem-visible');
    if (!dd.classList.contains('dem-visible')) return;
    dd.innerHTML = '';

    const title = el('div', { className: 'dem-move-option dem-dropdown-title' });
    title.textContent = '所属カテゴリ（複数選択可）';
    dd.appendChild(title);

    state.categories.forEach(cat => {
      const row = el('div', { className: 'dem-move-option dem-tag-row' });
      const allHave = state.selected.size > 0 && Array.from(state.selected).every(id =>
        getCategoryIds(id).includes(cat.id)
      );
      const check = el('span', { className: 'dem-tag-check' });
      check.textContent = allHave ? '☑' : '☐';
      const label = el('span');
      label.textContent = cat.name;
      row.appendChild(check); row.appendChild(label);
      row.onclick = () => {
        state.selected.forEach(id => {
          if (allHave) {
            state.tags[id] = getCategoryIds(id).filter(t => t !== cat.id);
            if (state.tags[id].length === 0) delete state.tags[id];
          } else {
            addCategory(id, cat.id);
          }
        });
        saveTags();
        toggleTagDropdown();
        toggleTagDropdown();
        renderCats();
      };
      dd.appendChild(row);
    });
  }

  function openTemplateModal() {
    if (state.selected.size === 0) return;
    openModal('template');
  }

  function createTemplate(name) {
    const emojis = Array.from(state.selected)
      .map(id => state.emojis.find(e => e.id === id))
      .filter(Boolean)
      .map(snapshotEmoji);
    if (emojis.length === 0) return;
    state.templates.push({
      id:     'tmpl_' + Date.now(),
      name,
      emojis,
    });
    saveTemplates();
    state.selected.clear();
    closeModal();
    renderGrid(); updateFooter();
  }

  function renderTemplates() {
    const pane = $('dem-tmpl-list');
    pane.innerHTML = '';

    if (state.templates.length === 0) {
      const empty = el('div', { className: 'dem-empty' });
      empty.textContent = '絵文字を複数選択して「📋保存」でテンプレートを作成';
      pane.appendChild(empty);
      return;
    }

    state.templates.forEach(tmpl => {
      const card = el('div', { className: 'dem-tmpl-card' });

      const nameRow = el('div', { className: 'dem-tmpl-name-row' });
      const nameEl  = el('span', { className: 'dem-tmpl-name' });
      nameEl.textContent = tmpl.name;
      const delBtn  = el('button', { className: 'dem-tmpl-del' });
      delBtn.textContent = '✕';
      delBtn.onclick = () => {
        state.templates = state.templates.filter(t => t.id !== tmpl.id);
        saveTemplates(); renderTemplates();
      };
      nameRow.appendChild(nameEl); nameRow.appendChild(delBtn);

      const preview = el('div', { className: 'dem-tmpl-preview' });
      tmpl.emojis.forEach((saved, idx) => {
        const emoji = resolveTemplateEmoji(saved);
        if (!emoji) return;
        const s = el('span', { className: 'dem-tmpl-emoji', title: emoji.name });
        s.draggable = true;
        s.dataset.idx = idx;
        if (emoji.unicode) {
          s.textContent = emoji.url;
        } else {
          const img = el('img', { src: emoji.url, alt: emoji.name });
          img.draggable = false;
          s.appendChild(img);
        }
        const removeBtn = el('button', { className: 'dem-tmpl-emoji-remove', title: '削除' });
        removeBtn.textContent = '×';
        removeBtn.onmousedown = e => e.stopPropagation();
        removeBtn.onclick = e => {
          e.stopPropagation();
          tmpl.emojis.splice(idx, 1);
          saveTemplates(); renderTemplates();
        };
        s.appendChild(removeBtn);
        s.addEventListener('dragstart', e => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
          s.classList.add('dem-dragging');
        });
        s.addEventListener('dragend', () => s.classList.remove('dem-dragging'));
        s.addEventListener('dragover', e => {
          e.preventDefault();
          preview.querySelectorAll('.dem-tmpl-drag-over').forEach(el => el.classList.remove('dem-tmpl-drag-over'));
          s.classList.add('dem-tmpl-drag-over');
        });
        s.addEventListener('dragleave', () => s.classList.remove('dem-tmpl-drag-over'));
        s.addEventListener('drop', e => {
          e.preventDefault();
          s.classList.remove('dem-tmpl-drag-over');
          const from = Number(e.dataTransfer.getData('text/plain'));
          const to = idx;
          if (!Number.isInteger(from) || from === to) return;
          const [moving] = tmpl.emojis.splice(from, 1);
          tmpl.emojis.splice(to, 0, moving);
          saveTemplates(); renderTemplates();
        });
        preview.appendChild(s);
      });

      const controls = el('div', { className: 'dem-tmpl-actions' });
      const insertBtn = el('button', { className: 'dem-tmpl-insert' });
      insertBtn.textContent = '挿入';
      insertBtn.onclick = () => {
        tmpl.emojis.forEach(saved => {
          const emoji = resolveTemplateEmoji(saved);
          if (emoji) insertEmoji(emoji);
        });
      };
      const addBtn = el('button', { className: 'dem-tmpl-add-selected' });
      addBtn.textContent = '選択中を追加';
      addBtn.disabled = state.selected.size === 0;
      addBtn.onclick = () => {
        const existing = new Set(tmpl.emojis.map(saved => typeof saved === 'string' ? saved : saved.id));
        const additions = Array.from(state.selected)
          .map(id => state.emojis.find(e => e.id === id))
          .filter(e => e && !existing.has(e.id))
          .map(snapshotEmoji);
        if (additions.length === 0) return;
        tmpl.emojis.push(...additions);
        saveTemplates(); renderTemplates();
      };
      controls.appendChild(insertBtn);
      controls.appendChild(addBtn);

      card.appendChild(nameRow);
      card.appendChild(preview);
      card.appendChild(controls);
      pane.appendChild(card);
    });
  }

  function snapshotEmoji(e) {
    return {
      id: e.id,
      name: e.name,
      url: e.url,
      guildName: e.guildName,
      unicode: e.unicode,
      reactionName: e.reactionName,
      aliases: e.aliases || [],
    };
  }

  function resolveTemplateEmoji(saved) {
    if (typeof saved === 'string') return state.emojis.find(e => e.id === saved);
    return state.emojis.find(e => e.id === saved.id) || saved;
  }

  function deleteCategory(catId) {
    state.categories = state.categories.filter(c => c.id !== catId);
    Object.keys(state.tags).forEach(emojiId => {
      state.tags[emojiId] = getCategoryIds(emojiId).filter(id => id !== catId);
      if (state.tags[emojiId].length === 0) delete state.tags[emojiId];
    });
    Object.keys(state.assignments).forEach(emojiId => {
      if (state.assignments[emojiId] === catId) delete state.assignments[emojiId];
    });
    if (state.currentCat === catId) state.currentCat = 'all';
    saveCats(); saveTags(); saveAssigns(); renderAll();
  }

  // カテゴリのドラッグ並び替え用フラグ
  let catDraggingId = null;

  function renderCats() {
    const wrap = $('dem-cats');
    wrap.innerHTML = '';

    // フィルター選択肢: すべて / 未分類 / 各カテゴリ
    const fixedTabs = [
      { id: 'all',   name: 'すべて' },
      { id: 'uncat', name: '未分類' },
    ];

    // 固定タブ（すべて・未分類）
    fixedTabs.forEach(cat => {
      const count = cat.id === 'all'
        ? state.emojis.length
        : state.emojis.filter(e =>
          getCategoryIds(e.id).length === 0
        ).length;
      const btn = el('button', { className: 'dem-cat-tab' + (state.currentCat === cat.id ? ' dem-active' : '') });
      btn.textContent = `${cat.name} (${count})`;
      btn.addEventListener('click', () => {
        state.currentCat = cat.id; state.selected.clear();
        renderCats(); renderGrid(); updateFooter();
      });
      // 「未分類」タブへのドロップ → 割り当て解除
      if (cat.id === 'uncat') {
        btn.addEventListener('dragover', e => {
          if (catDraggingId) return; // カテゴリ並び替え中は無視
          e.preventDefault(); btn.classList.add('dem-drop-hover');
        });
        btn.addEventListener('dragleave', () => btn.classList.remove('dem-drop-hover'));
        btn.addEventListener('drop', e => {
          e.preventDefault(); btn.classList.remove('dem-drop-hover');
          if (!dragIds) return;
          dragIds.forEach(clearCategories);
          saveTags(); saveAssigns(); state.selected.clear(); dragIds = null; renderAll();
        });
      }
      wrap.appendChild(btn);
    });

    // カスタムカテゴリタブ（ドラッグ並び替え対応）
    state.categories.forEach(cat => {
      const count = state.emojis.filter(e => getCategoryIds(e.id).includes(cat.id)).length;
      const btn = el('button', {
        className: 'dem-cat-tab' + (state.currentCat === cat.id ? ' dem-active' : ''),
        draggable: true,
      });
      const label = el('span', { className: 'dem-cat-label' });
      label.textContent = `${cat.name} (${count})`;
      const delBtn = el('button', { className: 'dem-cat-delete', title: 'カテゴリを削除' });
      delBtn.textContent = '×';
      delBtn.onmousedown = e => e.stopPropagation();
      delBtn.onclick = e => {
        e.stopPropagation();
        deleteCategory(cat.id);
      };
      btn.appendChild(label);
      btn.appendChild(delBtn);

      btn.addEventListener('click', () => {
        if (catDraggingId) return; // ドラッグ後の誤クリック防止
        state.currentCat = cat.id; state.selected.clear();
        renderCats(); renderGrid(); updateFooter();
      });

      // ── カテゴリタブ自体のドラッグ（並び替え） ──
      btn.addEventListener('dragstart', e => {
        catDraggingId = cat.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ''); // Firefox対策
        setTimeout(() => btn.style.opacity = '0.4', 0);
      });
      btn.addEventListener('dragend', () => {
        btn.style.opacity = '';
        catDraggingId = null;
        wrap.querySelectorAll('.dem-cat-drag-over-left, .dem-cat-drag-over-right')
          .forEach(el => el.classList.remove('dem-cat-drag-over-left', 'dem-cat-drag-over-right'));
      });

      // ── 別のカテゴリタブの上にドラッグ → 並び替えプレビュー ──
      btn.addEventListener('dragover', e => {
        e.preventDefault();
        if (!catDraggingId || catDraggingId === cat.id) return;
        // 絵文字のドロップは弾く
        if (dragIds) return;
        e.dataTransfer.dropEffect = 'move';
        wrap.querySelectorAll('.dem-cat-drag-over-left, .dem-cat-drag-over-right')
          .forEach(el => el.classList.remove('dem-cat-drag-over-left', 'dem-cat-drag-over-right'));
        const rect   = btn.getBoundingClientRect();
        const isLeft = e.clientX < rect.left + rect.width / 2;
        btn.classList.add(isLeft ? 'dem-cat-drag-over-left' : 'dem-cat-drag-over-right');
      });
      btn.addEventListener('dragleave', () => {
        btn.classList.remove('dem-cat-drag-over-left', 'dem-cat-drag-over-right');
      });
      btn.addEventListener('drop', e => {
        e.preventDefault();
        const insertAfter = btn.classList.contains('dem-cat-drag-over-right');
        btn.classList.remove('dem-cat-drag-over-left', 'dem-cat-drag-over-right');
        if (!catDraggingId || catDraggingId === cat.id || dragIds) return;

        // state.categories から移動元を取り出してターゲットの前後に挿入
        const fromIdx = state.categories.findIndex(c => c.id === catDraggingId);
        if (fromIdx === -1) return;
        const [moving] = state.categories.splice(fromIdx, 1);
        let toIdx = state.categories.findIndex(c => c.id === cat.id);
        state.categories.splice(insertAfter ? toIdx + 1 : toIdx, 0, moving);

        saveCats();
        catDraggingId = null;
        renderCats();
      });

      // ── 絵文字のドロップターゲット ──
      btn.addEventListener('dragover', e => {
        if (catDraggingId || !dragIds) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        btn.classList.add('dem-drop-hover');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('dem-drop-hover'));
      btn.addEventListener('drop', e => {
        if (catDraggingId || !dragIds) return;
        e.preventDefault();
        btn.classList.remove('dem-drop-hover');
        dragIds.forEach(id => addCategory(id, cat.id));
        saveTags(); state.selected.clear(); dragIds = null; renderAll();
      });

      wrap.appendChild(btn);
    });

    const addBtn = el('button', { className: 'dem-cat-add-tab' });
    addBtn.textContent = '＋ 追加';
    addBtn.onclick = () => openModal('category');
    wrap.appendChild(addBtn);
  }

  function getVisibleEmojis() {
    // emojiOrder に沿って並べ、未登録を末尾に追加
    const ordered = [
      ...state.emojiOrder.map(id => state.emojis.find(e => e.id === id)).filter(Boolean),
      ...state.emojis.filter(e => !state.emojiOrder.includes(e.id)),
    ];
    let list = ordered.filter(e => {
      if (state.search && !getEmojiSearchText(e).includes(state.search)) return false;
      if (state.currentCat === 'all')   return true;
      if (state.currentCat === 'uncat') return getCategoryIds(e.id).length === 0;
      return getCategoryIds(e.id).includes(state.currentCat);
      });
    if      (state.sortOrder === 'name')      list.sort((a,b) => a.name.localeCompare(b.name));
    else if (state.sortOrder === 'name_desc') list.sort((a,b) => b.name.localeCompare(a.name));
    else if (state.sortOrder === 'guild')     list.sort((a,b) => (a.guildName||'').localeCompare(b.guildName||''));
    return list;
  }

  function renderInfoBar() {
    const bar = $('dem-info-bar');
    if (state.selected.size === 0) { bar.classList.add('dem-hidden'); return; }

    // 選択中絵文字のカテゴリ集計
    const catCounts = {};
    state.selected.forEach(id => {
      const catIds = getCategoryIds(id);
      if (catIds.length === 0) {
        catCounts.__uncat__ = (catCounts.__uncat__ || 0) + 1;
        return;
      }
      catIds.forEach(catId => {
        catCounts[catId] = (catCounts[catId] || 0) + 1;
      });
    });
    const parts = Object.entries(catCounts).map(([catId, n]) =>
      `<span class="dem-info-tag">${getCatName(catId === '__uncat__' ? null : catId)} ×${n}</span>`
    ).join('');
    bar.innerHTML = `<span class="dem-info-label">選択中のカテゴリ：</span>${parts}`;
    bar.classList.remove('dem-hidden');
  }

  function renderGrid() {
    const grid    = $('dem-grid');
    const visible = getVisibleEmojis();
    grid.innerHTML = '';

    if (visible.length === 0) {
      const d = el('div', { className: 'dem-empty' });
      d.textContent = state.emojis.length === 0 ? '絵文字ピッカーを一度開くとカスタム絵文字が読み込まれます' : '絵文字が見つかりません';
      grid.appendChild(d);
      return;
    }

    visible.forEach((emoji, visIdx) => {
      const item = el('div', {
        className: 'dem-emoji-item' + (state.selected.has(emoji.id) ? ' dem-selected' : ''),
        title: `:${emoji.name}:\n${emoji.guildName}`,
        draggable: true,
      });
      item.dataset.id  = emoji.id;
      item.dataset.idx = visIdx;

      if (emoji.unicode) {
        const s = el('span', { className: 'dem-emoji-static' });
        s.textContent = emoji.url;
        item.appendChild(s);
      } else {
        const img = el('img', { className: 'dem-emoji-img', src: emoji.url, alt: emoji.name });
        img.loading   = 'lazy';
        img.draggable = false;           // ブラウザの画像ドラッグを無効化
        img.style.pointerEvents = 'none'; // クリック/ドラッグイベントを親に委譲
        item.appendChild(img);
      }
      const nm = el('div', { className: 'dem-emoji-name' });
      nm.textContent = emoji.name;
      item.appendChild(nm);

      // カテゴリバッジ（選択中のみ表示）
      if (state.selected.has(emoji.id)) {
        const badge   = el('div', { className: 'dem-emoji-badge' });
        badge.textContent = getMembershipLabel(emoji.id);
        item.appendChild(badge);
      }

      // ── クリック ──
      let pressTimer;
      item.addEventListener('mousedown', () => {
        pressTimer = setTimeout(() => {
          state.selected.add(emoji.id);
          item.classList.add('dem-selected');
          updateFooter(); renderInfoBar();
        }, 400);
      });
      item.addEventListener('mouseup',    () => clearTimeout(pressTimer));
      item.addEventListener('mouseleave', () => clearTimeout(pressTimer));
      item.addEventListener('click', e => {
        if (e.shiftKey || state.selected.size > 0) {
          if (state.selected.has(emoji.id)) state.selected.delete(emoji.id);
          else state.selected.add(emoji.id);
          item.classList.toggle('dem-selected');
          // バッジ再描画
          const badge = item.querySelector('.dem-emoji-badge');
          if (state.selected.has(emoji.id)) {
            if (!badge) {
              const b = el('div', { className: 'dem-emoji-badge' });
              b.textContent = getMembershipLabel(emoji.id);
              item.appendChild(b);
            }
          } else {
            badge && badge.remove();
          }
          updateFooter(); renderInfoBar();
        } else {
          insertEmoji(emoji);
        }
      });

      // ── ドラッグ開始 ──
      item.addEventListener('dragstart', e => {
        clearTimeout(pressTimer);
        dragIds = state.selected.has(emoji.id) && state.selected.size > 0
          ? Array.from(state.selected)
          : [emoji.id];
        // text/plain に JSON を詰めて運ぶ（カスタムMIMEは拡張内では問題ないが念のため）
        e.dataTransfer.setData('text/plain', JSON.stringify(dragIds));
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => item.style.opacity = '0.35', 0);
      });
      item.addEventListener('dragend', () => {
        item.style.opacity = '';
        dragIds = null;
        document.querySelectorAll('.dem-drag-over').forEach(el => el.classList.remove('dem-drag-over'));
      });

      // ── グリッド内ドロップ（並び替え） ──
      // dragover: ターゲット絵文字の左半分 → 前に挿入、右半分 → 後に挿入
      item.addEventListener('dragover', e => {
        if (!dragIds) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.dem-drag-over, .dem-drag-over-after').forEach(el => {
          el.classList.remove('dem-drag-over', 'dem-drag-over-after');
        });
        if (dragIds.includes(emoji.id)) return;
        const rect   = item.getBoundingClientRect();
        const isLeft = e.clientX < rect.left + rect.width / 2;
        item.classList.add(isLeft ? 'dem-drag-over' : 'dem-drag-over-after');
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('dem-drag-over', 'dem-drag-over-after');
      });
      item.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        const insertAfter = item.classList.contains('dem-drag-over-after');
        item.classList.remove('dem-drag-over', 'dem-drag-over-after');

        const raw = e.dataTransfer.getData('text/plain');
        if (!raw) return;
        let ids;
        try { ids = JSON.parse(raw); } catch { return; }
        if (ids.includes(emoji.id)) return;

        // emojiOrder からドラッグ対象を除去
        ids.forEach(id => {
          const i = state.emojiOrder.indexOf(id);
          if (i !== -1) state.emojiOrder.splice(i, 1);
        });

        // ターゲットの位置を再取得して挿入
        let at = state.emojiOrder.indexOf(emoji.id);
        if (at === -1) {
          state.emojiOrder.push(...ids);
        } else {
          state.emojiOrder.splice(insertAfter ? at + 1 : at, 0, ...ids);
        }

        saveOrder();
        dragIds = null;
        // カスタム順に切替
        state.sortOrder = 'custom';
        $('dem-sort-btn').textContent = '↕ カスタム順';
        renderGrid();
      });

      grid.appendChild(item);
    });
  }

  function updateFooter() {
    const n   = state.selected.size;
    const inf = $('dem-sel-info'), tag = $('dem-tag-btn'), tmpl = $('dem-tmpl-save-btn'), ds = $('dem-desel-btn');
    inf.textContent = n === 0 ? 'クリックで挿入 / ドラッグで並び替え・所属追加' : `${n}個選択中`;
    tag.classList.toggle('dem-visible', n > 0);
    tmpl.classList.toggle('dem-visible', n > 0);
    ds.classList.toggle('dem-visible', n > 0);
    renderInfoBar();
  }

  // ── 絵文字挿入 ────────────────────────────────────────────────────────
  function insertEmoji(emoji) {
    // リアクションモードのとき → ピッカーの検索欄に入力
    if (state.reactionMode) {
      insertToReactionPicker(emoji);
      return;
    }
    // 通常モード → テキスト入力欄に挿入
    const input = findComposerInput();
    if (!input) return;
    input.focus();
    const text = emoji.unicode ? emoji.url + ' ' : `:${emoji.name}: `;
    const sel  = window.getSelection();
    if (sel && input.childNodes.length > 0) {
      const r = document.createRange();
      r.selectNodeContents(input); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    }
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    setTimeout(() => {
      if (!input.textContent.includes(text.trim()))
        document.execCommand('insertText', false, text);
    }, 50);
  }
  
  function insertToReactionPicker(emoji) {
    const picker = findEmojiPicker();
    const searchInput = picker ? findReactionSearchInput(picker) : findReactionSearchInput();
    if (!searchInput) return;
  
    // 検索欄に絵文字名を入力してReactのイベントを発火
    const name = getReactionSearchName(emoji);
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(searchInput, name);
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.focus();
  }

  // ── ソート ────────────────────────────────────────────────────────────
  function cycleSort() {
    const orders = ['custom','name','name_desc','guild'];
    const labels = { custom:'↕ カスタム順', name:'↑ 名前順', name_desc:'↓ 名前逆順', guild:'🏠 サーバー順' };
    state.sortOrder = orders[(orders.indexOf(state.sortOrder)+1) % orders.length];
    $('dem-sort-btn').textContent = labels[state.sortOrder];
    renderGrid();
  }

  // ── カテゴリ作成 ──────────────────────────────────────────────────────
  function openModal(mode = 'category')  {
    modalMode = mode;
    const isTemplate = mode === 'template';
    $('dem-modal').querySelector('h3').textContent = isTemplate ? 'テンプレートを保存' : '新しいカテゴリ';
    $('dem-modal-input').placeholder = isTemplate ? '例：朝の挨拶、定番リアクション' : '例：推し、リアクション用';
    $('dem-modal-ok').textContent = isTemplate ? '保存' : '作成';
    $('dem-modal-bg').classList.add('dem-visible');
    $('dem-modal-input').value = '';
    setTimeout(() => $('dem-modal-input').focus(), 50);
  }
  function closeModal() { $('dem-modal-bg').classList.remove('dem-visible'); }

  function submitModal() {
    const name = $('dem-modal-input').value.trim();
    if (!name) return;
    if (modalMode === 'template') createTemplate(name);
    else createCategory(name);
  }

  function createCategory(name) {
    state.categories.push({ id: 'cat_'+Date.now(), name });
    saveCats(); closeModal(); renderCats();
  }

  // ── 初期化 ────────────────────────────────────────────────────────────
  async function init() {
    if (document.readyState !== 'complete')
      await new Promise(r => window.addEventListener('load', r));
    const pos = await loadStorage();
    // Unicode絵文字を初期登録
    mergeEmojis(UNICODE_EMOJIS);
    buildPanel();
    if (pos) applyPos(pos);
    watchEmojiPicker();
    console.log('[DEM] 初期化完了');
  }

  let initialized = false;
  new MutationObserver(() => {
    if (!initialized && document.querySelector('[class*="app-"]')) {
      initialized = true; init();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.querySelector('[class*="app-"]')) { initialized = true; init(); }

})();
